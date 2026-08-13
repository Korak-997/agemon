import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";

const PLUGIN_ID = "daemon";
const UNIT_NAME = "agemon-crg-daemon.service";

const ACTION_TYPE_REGISTERED_SERVICE = "registered-service";
const ACTION_TYPE_PREEXISTING_SERVICE = "preexisting-service";
const ACTION_TYPE_ENABLED_LINGER = "enabled-linger";

function buildUnitContents(cwd: string): string {
  return [
    "[Unit]",
    "Description=agemon code-review-graph daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${cwd}`,
    "ExecStart=crg-daemon start",
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function hasManagedServiceRegistration(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_REGISTERED_SERVICE &&
      action.preExisting === false,
  );
}

function hasPreexistingServiceRecord(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_PREEXISTING_SERVICE &&
      action.preExisting === true,
  );
}

function enabledLingerByAgemon(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_ENABLED_LINGER &&
      action.preExisting === false,
  );
}

async function detectDaemon(ctx: Context): Promise<PluginPresence> {
  const status = await ctx.serviceManager.isActive(UNIT_NAME);
  if (!status.active) {
    return { present: false, preExisting: false };
  }

  if (hasManagedServiceRegistration(ctx)) {
    return { present: true, preExisting: false };
  }

  if (!hasPreexistingServiceRecord(ctx) && !ctx.dryRun) {
    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_PREEXISTING_SERVICE,
      target: UNIT_NAME,
      preExisting: true,
    });
  }

  return { present: true, preExisting: true };
}

async function installDaemon(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would register user service ${UNIT_NAME}`);
    ctx.ui.info("Would enable user linger when not already enabled");
    return;
  }

  const registration = await ctx.serviceManager.registerAutostart({
    unitName: UNIT_NAME,
    unitContents: buildUnitContents(ctx.cwd),
  });

  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_REGISTERED_SERVICE,
    target: registration.unitPath,
    preExisting: false,
  });

  if (registration.lingerEnabledByAgemon) {
    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_ENABLED_LINGER,
      target: process.env.USER ?? "current-user",
      preExisting: false,
    });
  }
}

async function verifyDaemon(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const status = await ctx.serviceManager.isActive(UNIT_NAME);
  if (!status.active) {
    return { ok: false, detail: "user service is not active" };
  }

  return { ok: true, detail: "service active" };
}

async function uninstallDaemon(ctx: Context): Promise<void> {
  const managedService = hasManagedServiceRegistration(ctx);

  if (ctx.dryRun) {
    if (managedService) {
      ctx.ui.info(`Would unregister user service ${UNIT_NAME}`);
      if (enabledLingerByAgemon(ctx)) {
        ctx.ui.info("Would disable user linger because agemon enabled it");
      }
    } else {
      ctx.ui.info(`Would keep pre-existing user service ${UNIT_NAME}`);
    }
    return;
  }

  if (managedService) {
    await ctx.serviceManager.unregisterAutostart({
      unitName: UNIT_NAME,
      disableLinger: enabledLingerByAgemon(ctx),
    });
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const daemonPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  dependsOn: ["crg"],
  detect: detectDaemon,
  install: installDaemon,
  verify: verifyDaemon,
  uninstall: uninstallDaemon,
};
