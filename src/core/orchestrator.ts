import { discoverRepository } from "../inspect/discover.js";
import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import { applyPlan } from "./apply.js";
import { buildConsentGates } from "./consent.js";
import type { Context } from "./context.js";
import {
  computePlanId,
  type Plan,
  resolveDesiredStateHash,
} from "./plan-store.js";

export interface OrchestratorOptions {
  only?: string;
}

export interface ReconcileOptions {
  only?: string;
  agemonVersion: string;
  allowUnignoredState: boolean;
  plan?: Plan;
}

export interface BuildPlanOptions {
  only?: string;
  agemonVersion: string;
}

function parseOnlyPluginIds(only?: string): string[] {
  if (!only) return [];
  return only
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function resolvePluginOrder(
  allPlugins: AgemonPlugin[],
  onlyIds: string[],
): AgemonPlugin[] {
  const pluginById = new Map(allPlugins.map((plugin) => [plugin.id, plugin]));
  const unresolvedOnlyIds = onlyIds.filter((id) => !pluginById.has(id));
  if (unresolvedOnlyIds.length > 0) {
    throw new Error(`Unknown plugin id(s): ${unresolvedOnlyIds.join(", ")}`);
  }

  const selected =
    onlyIds.length === 0
      ? [...allPlugins]
      : allPlugins.filter((plugin) => onlyIds.includes(plugin.id));

  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: AgemonPlugin[] = [];

  const visit = (plugin: AgemonPlugin): void => {
    if (permanent.has(plugin.id)) {
      return;
    }
    if (temporary.has(plugin.id)) {
      throw new Error(`Circular dependency detected at plugin '${plugin.id}'.`);
    }

    temporary.add(plugin.id);
    for (const dependencyId of plugin.dependsOn ?? []) {
      const dependencyPlugin = pluginById.get(dependencyId);
      if (!dependencyPlugin) {
        throw new Error(
          `Plugin '${plugin.id}' depends on missing plugin '${dependencyId}'.`,
        );
      }
      visit(dependencyPlugin);
    }
    temporary.delete(plugin.id);
    permanent.add(plugin.id);
    ordered.push(plugin);
  };

  for (const plugin of selected) {
    visit(plugin);
  }

  return ordered;
}

export async function buildPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: BuildPlanOptions,
): Promise<Plan> {
  const onlyIds = parseOnlyPluginIds(options.only);
  const plugins = resolvePluginOrder(allPlugins, onlyIds);

  const operations: ProposedOperation[] = [];
  for (const plugin of plugins) {
    const pluginOperations = (await plugin.plan?.(ctx)) ?? [];
    operations.push(...pluginOperations);
  }

  const desiredStateHash = resolveDesiredStateHash({
    capabilityIds: plugins.map((plugin) => plugin.id),
    skillGroups: ctx.skillGroupsOption ?? null,
  });

  return {
    id: computePlanId({
      agemonVersion: options.agemonVersion,
      desiredStateHash,
      operations,
    }),
    agemonVersion: options.agemonVersion,
    desiredStateHash,
    createdAt: new Date().toISOString(),
    operations,
  };
}

function reportSkippedOperations(
  ctx: Context,
  skipped: { operation: ProposedOperation; reason: string }[],
): void {
  for (const entry of skipped) {
    ctx.ui.info(
      `Skipped ${entry.operation.action} ${
        entry.operation.targetPath || entry.operation.resourceId
      } — ${entry.reason}`,
    );
  }
}

export async function reconcile(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: ReconcileOptions,
): Promise<void> {
  const plugins = resolvePluginOrder(
    allPlugins,
    parseOnlyPluginIds(options.only),
  );

  if (plugins.length === 0) {
    ctx.ui.info("Nothing to do — no capabilities selected.");
    return;
  }

  const plan =
    options.plan ??
    (await buildPlan(ctx, allPlugins, {
      only: options.only,
      agemonVersion: options.agemonVersion,
    }));

  const { isolation } = await discoverRepository(ctx);
  const gates = buildConsentGates({
    plan,
    isolationStatus: isolation.status,
  });
  const approval = await ctx.consent(gates);

  if (approval.approved.length === 0) {
    ctx.ui.info(
      "Nothing applied — every proposed operation was declined or skipped.",
    );
    reportSkippedOperations(ctx, approval.skipped);
    return;
  }

  const result = await applyPlan(ctx, allPlugins, {
    plan,
    approved: approval.approved,
    workspaceIsolationApproved: approval.workspaceIsolationApproved,
    isolationStatus: isolation.status,
    allowUnignoredState: options.allowUnignoredState,
  });

  ctx.ui.succeed(`Applied ${result.applied.length} operation(s).`);
  reportSkippedOperations(ctx, approval.skipped);
}

export async function uninstallPlugins(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: OrchestratorOptions,
): Promise<void> {
  const onlyIds = parseOnlyPluginIds(options.only);
  const plugins = resolvePluginOrder(allPlugins, onlyIds).reverse();

  if (plugins.length === 0) {
    ctx.ui.info("Nothing to do — no plugins selected.");
    return;
  }

  for (const plugin of plugins) {
    ctx.ui.start(`Uninstalling ${plugin.id}`);
    await plugin.uninstall(ctx);
    ctx.ui.succeed(`Uninstalled ${plugin.id}`);
  }

  await ctx.manifest.pruneIfEmpty();
}
