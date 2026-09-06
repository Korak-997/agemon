import { rm } from "node:fs/promises";
import { relative } from "node:path";
import { discoverRepository } from "../inspect/discover.js";
import { verifyManagedState } from "../inspect/status.js";
import { CORE_CAPABILITY_IDS } from "../plugins/index.js";
import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import { applyPlan } from "./apply.js";
import { resolveConfigPath, writeConfig } from "./config.js";
import type { ConflictResolution } from "./consent.js";
import { buildConsentGates } from "./consent.js";
import type { Context } from "./context.js";
import {
  computePlanId,
  type Plan,
  renderPlan,
  resolveDesiredStateHash,
  writePlan,
} from "./plan-store.js";
import { isInteractiveTerminal } from "./prompt.js";

type ConflictDecisionMap = Record<string, "keep-mine" | "skip">;

export interface OrchestratorOptions {
  only?: string;
}

export interface ReconcileOptions {
  only?: string;
  agemonVersion: string;
  allowUnignoredState: boolean;
  plan?: Plan;
  conflictDecisions?: ConflictDecisionMap;
  persistConfig?: boolean;
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

function reportSweepProblems(ctx: Context, problems: string[]): void {
  for (const problem of problems) {
    ctx.ui.info(`  - ${problem}`);
  }
}

async function runPostApplySweep(
  ctx: Context,
  plugins: AgemonPlugin[],
  appliedCapabilityIds: ReadonlySet<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const plugin of plugins) {
    if (!appliedCapabilityIds.has(plugin.id)) {
      continue;
    }
    const verification = await plugin.verify(ctx);
    if (!verification.ok) {
      problems.push(
        `${plugin.id}: ${verification.detail ?? "verification failed"}`,
      );
    }
  }
  problems.push(...(await verifyManagedState(ctx, plugins)));
  return problems;
}

async function persistDesiredStateConfig(
  ctx: Context,
  plugins: AgemonPlugin[],
  conflictResolutions: ConflictResolution[],
): Promise<void> {
  const conflictDecisions: ConflictDecisionMap = {};
  for (const resolution of conflictResolutions) {
    conflictDecisions[resolution.resourceId] = resolution.decision;
  }

  const configPath = await writeConfig(ctx.cwd, {
    capabilities: plugins
      .map((plugin) => plugin.id)
      .filter((id) => CORE_CAPABILITY_IDS.includes(id)),
    skillGroups: ctx.skillGroupsOption ?? null,
    conflictDecisions,
  });

  ctx.ui.info(
    `Wrote ${relative(ctx.cwd, configPath)} — commit it so teammates and CI reconcile the same way.`,
  );
}

async function removeDesiredStateConfig(ctx: Context): Promise<void> {
  await rm(resolveConfigPath(ctx.cwd), { force: true });
}

async function previewAndStop(ctx: Context, plan: Plan): Promise<void> {
  const planPath = await writePlan(ctx.cwd, plan);
  ctx.log.log(renderPlan(plan));
  ctx.log.log(`\nPlan written to ${relative(ctx.cwd, planPath)}`);
  if (plan.operations.length > 0) {
    ctx.log.log(
      `Review, then re-run interactively or with --yes, or 'agemon apply --plan ${plan.id}'.`,
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

  const sessionCannotConsent = !ctx.yes && !isInteractiveTerminal();
  const isFirstRun = options.persistConfig === true;
  if (
    ctx.dryRun ||
    (plan.operations.length > 0 && sessionCannotConsent && isFirstRun)
  ) {
    await previewAndStop(ctx, plan);
    return;
  }

  if (plan.operations.length === 0) {
    const driftProblems = await verifyManagedState(ctx, plugins);
    if (driftProblems.length > 0) {
      ctx.ui.fail("Nothing to apply, but the environment has drifted:");
      reportSweepProblems(ctx, driftProblems);
      return;
    }
    if (options.persistConfig) {
      await persistDesiredStateConfig(ctx, plugins, []);
    }
    ctx.ui.succeed(
      "Nothing to do — every managed resource already matches the desired state.",
    );
    return;
  }

  const { isolation } = await discoverRepository(ctx);
  const gates = buildConsentGates({
    plan,
    isolationStatus: isolation.status,
  });
  const approval = await ctx.consent(gates, {
    conflictDecisions: options.conflictDecisions,
  });

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

  reportSkippedOperations(ctx, approval.skipped);

  const appliedCapabilityIds = new Set(
    result.applied.map((operation) => operation.capabilityId),
  );
  const sweepProblems = await runPostApplySweep(
    ctx,
    plugins,
    appliedCapabilityIds,
  );
  if (sweepProblems.length > 0) {
    ctx.ui.fail(
      `Applied ${result.applied.length} operation(s), but post-apply verification found problems:`,
    );
    reportSweepProblems(ctx, sweepProblems);
    return;
  }

  if (options.persistConfig) {
    await persistDesiredStateConfig(ctx, plugins, approval.conflictResolutions);
  }

  ctx.ui.succeed(
    `Applied ${result.applied.length} operation(s); environment verified.`,
  );
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

  if (onlyIds.length === 0) {
    await removeDesiredStateConfig(ctx);
  }

  await ctx.manifest.pruneIfEmpty();
}
