import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import type { Context } from "./context.js";
import { ensureAgemonGitignored } from "./gitignore.js";
import {
  computePlanId,
  type Plan,
  resolveDesiredStateHash,
} from "./plan-store.js";

export interface OrchestratorOptions {
  only?: string;
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

function buildVerificationMessage(pluginId: string, detail?: string): string {
  if (!detail) return `Installed ${pluginId}`;
  return `Installed ${pluginId} (${detail})`;
}

function buildPresenceMessage(pluginId: string, detail?: string): string {
  if (!detail) return `Already installed ${pluginId}`;
  return `Already installed ${pluginId} (${detail})`;
}

async function installFresh(ctx: Context, plugin: AgemonPlugin): Promise<void> {
  ctx.ui.info(`${plugin.id} not detected — running a fresh install`);
  await plugin.install(ctx);
  const verification = await plugin.verify(ctx);
  if (!verification.ok) {
    ctx.ui.fail(`Verification failed for ${plugin.id}`);
    throw new Error(
      verification.detail ?? `Verification failed for plugin '${plugin.id}'.`,
    );
  }

  ctx.ui.succeed(buildVerificationMessage(plugin.id, verification.detail));
}

async function reconcileExisting(
  ctx: Context,
  plugin: AgemonPlugin,
): Promise<void> {
  const verification = await plugin.verify(ctx);
  if (verification.ok) {
    ctx.ui.succeed(buildPresenceMessage(plugin.id, verification.detail));
    return;
  }

  ctx.ui.info(
    `${plugin.id} is already present but not healthy: ${
      verification.detail ?? "no details available"
    }`,
  );

  const shouldFix = await ctx.confirm(`Rewrite/fix ${plugin.id} now?`);
  if (!shouldFix) {
    ctx.ui.fail(
      `Left ${plugin.id} as-is — re-run with --yes, or interactively, to fix it.`,
    );
    return;
  }

  await plugin.install(ctx);
  const reverification = await plugin.verify(ctx);
  if (!reverification.ok) {
    ctx.ui.fail(`Fix failed for ${plugin.id}`);
    throw new Error(
      reverification.detail ??
        `Verification failed for plugin '${plugin.id}' after a fix attempt.`,
    );
  }

  ctx.ui.succeed(
    `Fixed ${plugin.id} (${reverification.detail ?? "now healthy"})`,
  );
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

export async function installPlugins(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: OrchestratorOptions,
): Promise<void> {
  const onlyIds = parseOnlyPluginIds(options.only);
  const plugins = resolvePluginOrder(allPlugins, onlyIds);

  if (plugins.length === 0) {
    ctx.ui.info("Nothing to do — no plugins selected.");
    return;
  }

  for (const plugin of plugins) {
    ctx.ui.start(`Checking ${plugin.id}`);
    const presence = await plugin.detect(ctx);

    if (presence.present) {
      await reconcileExisting(ctx, plugin);
      continue;
    }

    await installFresh(ctx, plugin);
  }

  await ensureAgemonGitignored(ctx.cwd, ctx.dryRun);
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
