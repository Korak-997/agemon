import type { Context } from "../../core/context.js";
import { errorMessage } from "../../core/error-message.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { printable } from "../../core/untrusted-text.js";
import type { VerifiedArchiveCandidate } from "../../core/verified-binary-installer.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
} from "../types.js";
import { CLI_TOOL_BUNDLE, type CliToolBundleEntry } from "./catalog.js";

const PLUGIN_ID = "cli-tool";

const ACTION_TYPE_INSTALLED_CLI_TOOL = "installed-cli-tool";
const ACTION_TYPE_PREEXISTING_CLI_TOOL = "preexisting-cli-tool";

const VERSION_CHECK_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 180_000;
const UNINSTALL_TIMEOUT_MS = 60_000;

export function resolveVerifiedArchiveCandidates(
  entry: CliToolBundleEntry,
  platformKey: string,
): VerifiedArchiveCandidate[] {
  const archives = Object.hasOwn(entry.releaseArchivesByPlatform, platformKey)
    ? entry.releaseArchivesByPlatform[platformKey]
    : undefined;
  if (!archives) {
    throw new Error(
      `${entry.packageName} has no pinned build for ${platformKey}.`,
    );
  }
  return archives.map(({ asset, sha256 }) => ({
    url: `${entry.releaseDownloadUrl}/${asset}`,
    sha256,
  }));
}

function pinnedPackageSpec(entry: CliToolBundleEntry): string {
  return `${entry.packageName}@${entry.version}`;
}

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
  const result = await ctx.run(entry.binaryName, ["--version"], {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
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

async function describeCliToolsState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  return Promise.all(
    CLI_TOOL_BUNDLE.map(async (entry): Promise<CapabilityStateRow> => {
      const available = await isToolBinaryAvailable(ctx, entry);
      const resourceId = `package:${entry.id}`;

      if (!available) {
        return {
          capabilityId: PLUGIN_ID,
          resourceId,
          label: entry.binaryName,
          state: "absent",
          detail: null,
        };
      }

      const managed = hasManagedInstallRecord(ctx, entry.id);
      return {
        capabilityId: PLUGIN_ID,
        resourceId,
        label: entry.binaryName,
        state: managed ? "present-managed" : "present-adopted",
        detail: managed
          ? `installed via npm (${entry.packageName})`
          : "pre-existing install",
      };
    }),
  );
}

async function planCliTools(ctx: Context): Promise<ProposedOperation[]> {
  const missingEntries: CliToolBundleEntry[] = [];
  for (const entry of CLI_TOOL_BUNDLE) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      missingEntries.push(entry);
    }
  }

  return missingEntries.map((entry) =>
    describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: `package:${entry.id}`,
      targetPath: entry.packageName,
      action: "install-package",
      riskClass: "executes",
      requiresConsent: true,
      preview: {
        kind: "note",
        text: `npm install --global --ignore-scripts ${pinnedPackageSpec(entry)}; binary from the v${entry.version} GitHub release, sha256-pinned`,
      },
    }),
  );
}

async function uninstallGlobalPackage(
  ctx: Context,
  packageName: string,
): Promise<void> {
  const uninstallResult = await ctx.run(
    "npm",
    ["uninstall", "--global", packageName],
    {
      timeoutMs: UNINSTALL_TIMEOUT_MS,
    },
  );
  if (uninstallResult.code !== 0) {
    throw new Error(
      uninstallResult.stderr ||
        `npm global uninstall failed for ${packageName}`,
    );
  }
}

async function removePartlyInstalledPackage(
  ctx: Context,
  packageName: string,
  installError: unknown,
): Promise<void> {
  try {
    await uninstallGlobalPackage(ctx, packageName);
  } catch (uninstallError) {
    throw new Error(
      `${errorMessage(installError)} Removing the partly installed ${packageName} also failed (${errorMessage(uninstallError)}); run: npm uninstall --global ${packageName}`,
    );
  }
}

async function installPinnedCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  const candidates = resolveVerifiedArchiveCandidates(
    entry,
    `${process.platform}-${process.arch}`,
  );
  const installResult = await ctx.run(
    "npm",
    ["install", "--global", "--ignore-scripts", pinnedPackageSpec(entry)],
    {
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  if (installResult.code !== 0) {
    throw new Error(
      installResult.stderr ||
        `npm global install failed for ${pinnedPackageSpec(entry)}`,
    );
  }

  try {
    await ctx.verifiedBinaryInstaller.install({
      packageName: entry.packageName,
      version: entry.version,
      binaryPathInPackage: entry.binaryPathInPackage,
      archiveMemberName: entry.archiveMemberName,
      candidates,
    });
  } catch (installError) {
    await removePartlyInstalledPackage(ctx, entry.packageName, installError);
    throw new Error(
      `${errorMessage(installError)} agemon uninstalled the global npm package ${entry.packageName} again, so nothing is left half-installed.`,
      { cause: installError },
    );
  }
}

async function installCliTools(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    for (const entry of CLI_TOOL_BUNDLE) {
      ctx.ui.info(
        `Would install ${pinnedPackageSpec(entry)} globally via npm, with its sha256-pinned binary`,
      );
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

    await installPinnedCliTool(ctx, entry);
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

async function revertCliTools(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  const installedByAgemon = entries.filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_CLI_TOOL &&
      action.preExisting === false,
  );
  const managedPackageNames: string[] = [];
  for (const action of installedByAgemon) {
    const bundleEntry = CLI_TOOL_BUNDLE.find(
      (entry) => entry.id === action.target,
    );
    if (bundleEntry) {
      managedPackageNames.push(bundleEntry.packageName);
    } else {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(action.target)}: cli-tool does not manage that package`,
      );
    }
  }

  if (ctx.dryRun) {
    if (managedPackageNames.length === 0) {
      ctx.ui.info("Would keep pre-existing CLI tools untouched");
      return;
    }
    for (const packageName of managedPackageNames) {
      ctx.ui.info(`Would uninstall global npm package ${packageName}`);
    }
    return;
  }

  for (const packageName of managedPackageNames) {
    await uninstallGlobalPackage(ctx, packageName);
  }
}

async function uninstallCliTools(ctx: Context): Promise<void> {
  await revertCliTools(ctx, getPluginActions(ctx));
}

export const cliToolPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "executes",
  detect: detectCliTools,
  describeState: describeCliToolsState,
  plan: planCliTools,
  install: installCliTools,
  verify: verifyCliTools,
  revert: revertCliTools,
  uninstall: uninstallCliTools,
};
