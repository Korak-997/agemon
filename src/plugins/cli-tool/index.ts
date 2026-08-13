import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";
import { CLI_TOOL_BUNDLE, type CliToolBundleEntry } from "./catalog.js";

const PLUGIN_ID = "cli-tool";

const ACTION_TYPE_INSTALLED_CLI_TOOL = "installed-cli-tool";
const ACTION_TYPE_PREEXISTING_CLI_TOOL = "preexisting-cli-tool";

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function hasManagedInstallRecord(ctx: Context, toolId: string): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_CLI_TOOL &&
      action.target === toolId &&
      action.preExisting === false,
  );
}

function hasPreexistingRecord(ctx: Context, toolId: string): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_PREEXISTING_CLI_TOOL &&
      action.target === toolId &&
      action.preExisting === true,
  );
}

function hasAnyRecordForTool(ctx: Context, toolId: string): boolean {
  return (
    hasManagedInstallRecord(ctx, toolId) || hasPreexistingRecord(ctx, toolId)
  );
}

async function isToolBinaryAvailable(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<boolean> {
  const result = await ctx.run(entry.binaryName, ["--version"]);
  return result.code === 0;
}

async function detectCliTools(ctx: Context): Promise<PluginPresence> {
  const bundleAvailability = await Promise.all(
    CLI_TOOL_BUNDLE.map(async (entry) => ({
      entry,
      available: await isToolBinaryAvailable(ctx, entry),
    })),
  );

  if (bundleAvailability.some((tool) => !tool.available)) {
    return { present: false, preExisting: false };
  }

  const allManaged = CLI_TOOL_BUNDLE.every((entry) =>
    hasManagedInstallRecord(ctx, entry.id),
  );
  if (allManaged) {
    return { present: true, preExisting: false };
  }

  if (!ctx.dryRun) {
    for (const { entry } of bundleAvailability) {
      if (hasAnyRecordForTool(ctx, entry.id)) {
        continue;
      }
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_PREEXISTING_CLI_TOOL,
        target: entry.id,
        preExisting: true,
      });
    }
  }

  return { present: true, preExisting: true };
}

async function installCliTools(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    for (const entry of CLI_TOOL_BUNDLE) {
      ctx.ui.info(`Would install ${entry.packageName} globally via npm`);
    }
    return;
  }

  for (const entry of CLI_TOOL_BUNDLE) {
    const toolIsAvailable = await isToolBinaryAvailable(ctx, entry);
    if (toolIsAvailable) {
      if (!hasAnyRecordForTool(ctx, entry.id)) {
        await ctx.manifest.recordAction({
          plugin: PLUGIN_ID,
          type: ACTION_TYPE_PREEXISTING_CLI_TOOL,
          target: entry.id,
          preExisting: true,
        });
      }
      continue;
    }

    const installResult = await ctx.run("npm", [
      "install",
      "--global",
      entry.packageName,
    ]);
    if (installResult.code !== 0) {
      throw new Error(
        installResult.stderr ||
          `npm global install failed for ${entry.packageName}`,
      );
    }

    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_INSTALLED_CLI_TOOL,
      target: entry.id,
      preExisting: false,
    });
  }
}

async function verifyCliTools(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const missingToolIds: string[] = [];
  for (const entry of CLI_TOOL_BUNDLE) {
    const toolIsAvailable = await isToolBinaryAvailable(ctx, entry);
    if (!toolIsAvailable) {
      missingToolIds.push(entry.id);
    }
  }

  if (missingToolIds.length > 0) {
    return {
      ok: false,
      detail: `Missing CLI tool(s): ${missingToolIds.join(", ")}`,
    };
  }

  return {
    ok: true,
    detail: `${CLI_TOOL_BUNDLE.length} CLI tool bundle entries present`,
  };
}

async function uninstallCliTools(ctx: Context): Promise<void> {
  const managedActions = getPluginActions(ctx).filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_CLI_TOOL &&
      action.preExisting === false,
  );

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep pre-existing CLI tools untouched");
      return;
    }
    for (const action of managedActions) {
      const bundleEntry = CLI_TOOL_BUNDLE.find(
        (entry) => entry.id === action.target,
      );
      const packageName = bundleEntry?.packageName ?? action.target;
      ctx.ui.info(`Would uninstall global npm package ${packageName}`);
    }
    return;
  }

  for (const action of managedActions) {
    const bundleEntry = CLI_TOOL_BUNDLE.find(
      (entry) => entry.id === action.target,
    );
    const packageName = bundleEntry?.packageName ?? action.target;

    const uninstallResult = await ctx.run("npm", [
      "uninstall",
      "--global",
      packageName,
    ]);
    if (uninstallResult.code !== 0) {
      throw new Error(
        uninstallResult.stderr ||
          `npm global uninstall failed for ${packageName}`,
      );
    }
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const cliToolPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  detect: detectCliTools,
  install: installCliTools,
  verify: verifyCliTools,
  uninstall: uninstallCliTools,
};
