import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";

const PLUGIN_ID = "crg";
const PACKAGE_NAME = "code-review-graph";
const PIPX_RUN_PREFIX = ["run", "--spec", PACKAGE_NAME, "code-review-graph"];

const VERSION_CHECK_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 30_000;
const UNINSTALL_TIMEOUT_MS = 120_000;

const ACTION_TYPE_INSTALLED_BINARY = "installed-binary";
const ACTION_TYPE_PREEXISTING_BINARY = "preexisting-binary";
const ACTION_TYPE_GRAPH_BUILT = "graph-built";

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function hasManagedInstall(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_BINARY &&
      action.preExisting === false,
  );
}

function hasPreexistingRecord(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_PREEXISTING_BINARY &&
      action.preExisting === true,
  );
}

async function detectCrgPresence(ctx: Context): Promise<PluginPresence> {
  const versionCheck = await ctx.run("code-review-graph", ["--version"], {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  const commandIsAvailable = versionCheck.code === 0;

  if (!commandIsAvailable) {
    return { present: false, preExisting: false };
  }

  if (hasManagedInstall(ctx)) {
    return { present: true, preExisting: false };
  }

  if (!hasPreexistingRecord(ctx) && !ctx.dryRun) {
    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_PREEXISTING_BINARY,
      target: PACKAGE_NAME,
      preExisting: true,
    });
  }

  return { present: true, preExisting: true };
}

async function installCrg(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would install ${PACKAGE_NAME} via pipx`);
    ctx.ui.info("Would build graph for current repository");
    return;
  }

  const installResult = await ctx.run("pipx", ["install", PACKAGE_NAME], {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (installResult.code !== 0) {
    throw new Error(
      installResult.stderr || `pipx install failed for ${PACKAGE_NAME}`,
    );
  }

  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_INSTALLED_BINARY,
    target: `${PACKAGE_NAME} (pipx)`,
    preExisting: false,
  });

  const buildResult = await ctx.run("pipx", [...PIPX_RUN_PREFIX, "build"], {
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (buildResult.code !== 0) {
    throw new Error(buildResult.stderr || "code-review-graph build failed");
  }

  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_GRAPH_BUILT,
    target: ".code-review-graph",
    preExisting: false,
  });
}

async function verifyCrg(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const statusResult = await ctx.run("pipx", [...PIPX_RUN_PREFIX, "status"], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (statusResult.code !== 0) {
    return {
      ok: false,
      detail: statusResult.stderr || "code-review-graph status failed",
    };
  }

  return { ok: true, detail: "status command passed" };
}

async function uninstallCrg(ctx: Context): Promise<void> {
  const managedInstall = hasManagedInstall(ctx);

  if (ctx.dryRun) {
    if (managedInstall) {
      ctx.ui.info(`Would uninstall ${PACKAGE_NAME} from pipx`);
    } else {
      ctx.ui.info(`Would keep pre-existing ${PACKAGE_NAME} install`);
    }
    return;
  }

  if (managedInstall) {
    const uninstallResult = await ctx.run("pipx", ["uninstall", PACKAGE_NAME], {
      timeoutMs: UNINSTALL_TIMEOUT_MS,
    });
    if (uninstallResult.code !== 0) {
      throw new Error(
        uninstallResult.stderr || `pipx uninstall failed for ${PACKAGE_NAME}`,
      );
    }
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const crgPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  detect: detectCrgPresence,
  install: installCrg,
  verify: verifyCrg,
  uninstall: uninstallCrg,
};
