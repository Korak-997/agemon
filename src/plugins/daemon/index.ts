import { basename } from "node:path";
import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";

const PLUGIN_ID = "daemon";
const UNIT_NAME_PREFIX = "agemon-crg-daemon";
const UNIT_NAME_MAX_SLUG_LENGTH = 40;
const GIT_TOPLEVEL_TIMEOUT_MS = 10_000;

const ACTION_TYPE_REGISTERED_SERVICE = "registered-service";
const ACTION_TYPE_PREEXISTING_SERVICE = "preexisting-service";
const ACTION_TYPE_ENABLED_LINGER = "enabled-linger";

function slugifyForUnitName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "repo").slice(0, UNIT_NAME_MAX_SLUG_LENGTH);
}

/**
 * The unit is named after the repo (or plain directory, outside a git repo)
 * agemon is running in — a single fixed unit name would collide across
 * every project on the machine, with the daemon registered last silently
 * overwriting and restarting every other project's unit file.
 */
async function resolveUnitName(ctx: Context): Promise<string> {
  const gitToplevel = await ctx.run("git", ["rev-parse", "--show-toplevel"], {
    timeoutMs: GIT_TOPLEVEL_TIMEOUT_MS,
  });
  const repoRoot = gitToplevel.code === 0 ? gitToplevel.stdout.trim() : ctx.cwd;
  return `${UNIT_NAME_PREFIX}-${slugifyForUnitName(basename(repoRoot))}.service`;
}

type HardeningProfile = "strict" | "compat";

function readHardeningProfileFromEnv(): HardeningProfile {
  return process.env.AGEMON_DAEMON_HARDENING === "compat" ? "compat" : "strict";
}

function getHardeningDirectives(profile: HardeningProfile): string[] {
  if (profile === "compat") {
    return ["NoNewPrivileges=yes", "RestrictSUIDSGID=yes"];
  }

  return [
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "ProtectSystem=full",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
  ];
}

function buildUnitContents(cwd: string, profile: HardeningProfile): string {
  return [
    "[Unit]",
    "Description=agemon code-review-graph daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${cwd}`,
    "ExecStart=code-review-graph watch",
    ...getHardeningDirectives(profile),
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
  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
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
      target: unitName,
      preExisting: true,
    });
  }

  return { present: true, preExisting: true };
}

async function installDaemon(ctx: Context): Promise<void> {
  const unitName = await resolveUnitName(ctx);

  if (ctx.dryRun) {
    ctx.ui.info(`Would register user service ${unitName}`);
    ctx.ui.info("Would enable user linger when not already enabled");
    return;
  }

  const configuredProfile = readHardeningProfileFromEnv();
  const registration = await (async () => {
    try {
      return await ctx.serviceManager.registerAutostart({
        unitName,
        unitContents: buildUnitContents(ctx.cwd, configuredProfile),
      });
    } catch (error) {
      if (configuredProfile !== "strict") {
        throw error;
      }

      ctx.ui.info(
        "Strict daemon hardening failed; retrying with compatibility hardening.",
      );
      return await ctx.serviceManager.registerAutostart({
        unitName,
        unitContents: buildUnitContents(ctx.cwd, "compat"),
      });
    }
  })();

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

  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
  if (!status.active) {
    return { ok: false, detail: `${unitName} is not active` };
  }

  return { ok: true, detail: `${unitName} active` };
}

async function uninstallDaemon(ctx: Context): Promise<void> {
  const unitName = await resolveUnitName(ctx);
  const managedService = hasManagedServiceRegistration(ctx);

  if (ctx.dryRun) {
    if (managedService) {
      ctx.ui.info(`Would unregister user service ${unitName}`);
      if (enabledLingerByAgemon(ctx)) {
        ctx.ui.info("Would disable user linger because agemon enabled it");
      }
    } else {
      ctx.ui.info(`Would keep pre-existing user service ${unitName}`);
    }
    return;
  }

  if (managedService) {
    await ctx.serviceManager.unregisterAutostart({
      unitName,
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
