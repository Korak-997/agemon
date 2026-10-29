import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import { errorMessage } from "../../core/error-message.js";
import { readMachineLedger } from "../../core/machine-ledger.js";
import { resolveGlobalNpmRoot } from "../../core/npm-global.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { resolveAgemonStateDirectory } from "../../core/state-root.js";
import { printable } from "../../core/untrusted-text.js";
import type {
  InstalledPackageInspection,
  VerifiedArchiveCandidate,
} from "../../core/verified-binary-installer.js";
import type { PlatformCapabilities } from "../../platform/detect.js";
import { describeOperation } from "../proposed-operation.js";
import {
  addSharedHolder,
  createSharedResource,
  describeUseSharedOperation,
  isHeldByThisRepository,
  releaseSharedResource,
  repoLedgerUsesSharedResource,
  wasInstalledByAgemon,
} from "../shared-resource.js";
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
const UNINSTALL_TIMEOUT_MS = 60_000;

export function pinnedArchiveKeyFor(platform: PlatformCapabilities): string {
  return `${platform.family}-${platform.arch}`;
}

export function hasPinnedBuildFor(platform: PlatformCapabilities): boolean {
  const platformKey = pinnedArchiveKeyFor(platform);
  return CLI_TOOL_BUNDLE.every((entry) =>
    Object.hasOwn(entry.releaseArchivesByPlatform, platformKey),
  );
}

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

const inspectionsByContext = new WeakMap<
  Context,
  Map<string, Promise<InstalledPackageInspection>>
>();

function forgetInspections(ctx: Context): void {
  inspectionsByContext.delete(ctx);
}

function inspectInstalledTool(
  ctx: Context,
  entry: CliToolBundleEntry,
  options: { fresh?: boolean } = {},
): Promise<InstalledPackageInspection> {
  const inspections = inspectionsByContext.get(ctx) ?? new Map();
  inspectionsByContext.set(ctx, inspections);
  const cached = options.fresh ? undefined : inspections.get(entry.id);
  if (cached) {
    return cached;
  }
  const inspection = ctx.verifiedBinaryInstaller.inspect({
    packageName: entry.packageName,
    commandName: entry.binaryName,
    commandPathInPackage: entry.commandPathInPackage,
    binaryPathInPackage: entry.binaryPathInPackage,
    packageFileSha256: entry.packageFileSha256,
    binarySha256: entry.binarySha256,
  });
  inspections.set(entry.id, inspection);
  return inspection;
}

function isInstalledByAgemon(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<boolean> {
  return wasInstalledByAgemon(
    entry.sharedResource,
    hasManagedInstallRecord(ctx, entry.id),
  );
}

async function unpinnedFilesOfAgemonInstall(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<string[]> {
  if (!(await isInstalledByAgemon(ctx, entry))) {
    return [];
  }
  const inspection = await inspectInstalledTool(ctx, entry);
  return inspection.kind === "installed" ? inspection.differences : [];
}

async function isToolBinaryAvailable(
  ctx: Context,
  entry: CliToolBundleEntry,
  options: { fresh?: boolean } = {},
): Promise<boolean> {
  if (await isInstalledByAgemon(ctx, entry)) {
    const inspection = await inspectInstalledTool(ctx, entry, options);
    if (inspection.kind === "absent") {
      return false;
    }
    if (inspection.differences.length > 0) {
      return true;
    }
  }
  const result = await ctx.run(entry.binaryName, ["--version"], {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  return result.code === 0;
}

async function detectCliTools(ctx: Context): Promise<PluginPresence> {
  for (const entry of CLI_TOOL_BUNDLE) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      return { present: false, preExisting: false };
    }
  }
  const allManaged = CLI_TOOL_BUNDLE.every((entry) =>
    hasManagedInstallRecord(ctx, entry.id),
  );
  return { present: true, preExisting: !allManaged };
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
      const inspection = await inspectInstalledTool(ctx, entry);
      const installed =
        inspection.kind !== "installed"
          ? entry.packageName
          : inspection.version === null
            ? `${entry.packageName}; agemon could not inspect it (${inspection.differences.join("; ")})`
            : `${entry.packageName} ${inspection.version}${inspection.differences.length > 0 ? `, not the pinned ${entry.version} build` : ""}`;
      return {
        capabilityId: PLUGIN_ID,
        resourceId,
        label: entry.binaryName,
        state: managed ? "present-managed" : "present-adopted",
        detail: managed
          ? `installed via npm (${installed})`
          : `pre-existing install (${installed})`,
      };
    }),
  );
}

function describeInstallOperation(
  entry: CliToolBundleEntry,
): ProposedOperation {
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: `package:${entry.id}`,
    targetPath: entry.packageName,
    action: "install-package",
    riskClass: "executes",
    requiresConsent: true,
    preview: {
      kind: "note",
      text: `npm install --global --ignore-scripts of the sha512-pinned ${pinnedPackageSpec(entry)} tarball; binary from the v${entry.version} GitHub release, sha256-pinned`,
    },
  });
}

async function planCliTools(ctx: Context): Promise<ProposedOperation[]> {
  const operations: ProposedOperation[] = [];
  for (const entry of CLI_TOOL_BUNDLE) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      operations.push(describeInstallOperation(entry));
    } else if (
      !(
        entriesForTool(getPluginActions(ctx), entry).usesIt &&
        (await isHeldByThisRepository(ctx, entry.sharedResource))
      )
    ) {
      operations.push(
        describeUseSharedOperation(
          PLUGIN_ID,
          entry.sharedResource,
          hasManagedInstallRecord(ctx, entry.id),
        ),
      );
    }
  }
  return operations;
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

async function assertNoForeignGlobalPackage(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  const npmRoot = await resolveGlobalNpmRoot(ctx.run, {
    cwd: (await resolveAgemonStateDirectory("prepare")).path,
    mayNotExistYet: true,
  });
  const packagePath = join(npmRoot, entry.packageName);
  try {
    await lstat(packagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const recordedByAgemon =
    (await readMachineLedger()).resources[entry.sharedResource.id] !==
    undefined;
  throw new Error(
    recordedByAgemon
      ? `${entry.packageName} is installed but '${entry.binaryName} --version' fails on your PATH (it is recorded in the shared-tools ledger); fix your PATH, then run agemon again.`
      : `A global npm ${entry.packageName} already exists at ${printable(packagePath)} but '${entry.binaryName} --version' fails on your PATH — fix it or run 'npm uninstall --global ${entry.packageName}', then run agemon again.`,
  );
}

async function installPinnedCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  await assertNoForeignGlobalPackage(ctx, entry);
  const candidates = resolveVerifiedArchiveCandidates(
    entry,
    pinnedArchiveKeyFor(ctx.platform),
  );
  try {
    await ctx.verifiedBinaryInstaller.install({
      packageName: entry.packageName,
      version: entry.version,
      binaryPathInPackage: entry.binaryPathInPackage,
      archiveMemberName: entry.archiveMemberName,
      candidates,
      packageTarball: entry.packageTarball,
    });
  } catch (installError) {
    await removePartlyInstalledPackage(ctx, entry.packageName, installError);
    throw new Error(
      `${errorMessage(installError)} agemon uninstalled the global npm package ${entry.packageName} again, so nothing is left half-installed.`,
      { cause: installError },
    );
  }
}

async function installSharedCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(
      `Would install the sha512-pinned ${pinnedPackageSpec(entry)} tarball globally via npm, with its sha256-pinned binary`,
    );
    return;
  }
  await createSharedResource(ctx, PLUGIN_ID, entry.sharedResource, {
    isPresent: () => isToolBinaryAvailable(ctx, entry, { fresh: true }),
    create: async () => {
      try {
        await installPinnedCliTool(ctx, entry);
      } finally {
        forgetInspections(ctx);
      }
    },
    async recordInstall() {
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_INSTALLED_CLI_TOOL,
        target: entry.id,
        preExisting: false,
      });
    },
  });
}

async function useInstalledCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would record that this repository uses ${entry.binaryName}`);
    return;
  }
  await addSharedHolder(ctx, PLUGIN_ID, entry.sharedResource, {
    isPresent: () => isToolBinaryAvailable(ctx, entry, { fresh: true }),
    repoLedgerSaysInstalled: hasManagedInstallRecord(ctx, entry.id),
  });
}

async function installCliTools(ctx: Context): Promise<void> {
  for (const entry of CLI_TOOL_BUNDLE) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      await installSharedCliTool(ctx, entry);
    }
  }
}

async function applyCliTools(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<void> {
  for (const operation of operations) {
    const installEntry = CLI_TOOL_BUNDLE.find(
      (entry) => operation.resourceId === `package:${entry.id}`,
    );
    const sharedEntry = CLI_TOOL_BUNDLE.find(
      (entry) => operation.resourceId === entry.sharedResource.id,
    );
    if (operation.action === "install-package" && installEntry) {
      await installSharedCliTool(ctx, installEntry);
    } else if (operation.action === "use-shared" && sharedEntry) {
      await useInstalledCliTool(ctx, sharedEntry);
    }
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

  const attention: string[] = [];
  for (const entry of CLI_TOOL_BUNDLE) {
    const differences = await unpinnedFilesOfAgemonInstall(ctx, entry);
    if (differences.length > 0) {
      attention.push(
        `${entry.binaryName} is not the pinned ${entry.packageName} ${entry.version} build (${differences.join("; ")}); reinstall it: npm uninstall --global ${entry.packageName}, then run agemon`,
      );
    }
  }

  return {
    ok: true,
    detail: `${CLI_TOOL_BUNDLE.length} CLI tool bundle entries present`,
    ...(attention.length > 0 ? { attention: attention.join(" ") } : {}),
  };
}

function entriesForTool(
  entries: LedgerEntry[],
  entry: CliToolBundleEntry,
): { installedIt: boolean; usesIt: boolean } {
  const installedIt = entries.some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_CLI_TOOL &&
      action.target === entry.id &&
      action.preExisting === false,
  );
  const usesIt =
    installedIt ||
    repoLedgerUsesSharedResource(entries, entry.sharedResource) ||
    entries.some(
      (action) =>
        action.type === ACTION_TYPE_PREEXISTING_CLI_TOOL &&
        action.target === entry.id,
    );
  return { installedIt, usesIt };
}

function reportUnmanagedTargets(ctx: Context, entries: LedgerEntry[]): void {
  for (const action of entries) {
    const isToolEntry =
      action.type === ACTION_TYPE_INSTALLED_CLI_TOOL ||
      action.type === ACTION_TYPE_PREEXISTING_CLI_TOOL;
    if (
      isToolEntry &&
      !CLI_TOOL_BUNDLE.some((entry) => entry.id === action.target)
    ) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(action.target)}: cli-tool does not manage that package`,
      );
    }
  }
}

async function revertCliTools(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  reportUnmanagedTargets(ctx, entries);
  let releasedAny = false;
  for (const entry of CLI_TOOL_BUNDLE) {
    const { installedIt, usesIt } = entriesForTool(entries, entry);
    if (!usesIt) {
      continue;
    }
    releasedAny = true;
    await releaseSharedResource(ctx, entry.sharedResource, {
      releasingRepoInstalledIt: installedIt,
      isPresent: async () => true,
      remove: async () => {
        await uninstallGlobalPackage(ctx, entry.packageName);
        forgetInspections(ctx);
      },
    });
  }
  if (ctx.dryRun && !releasedAny) {
    ctx.ui.info("Would keep pre-existing CLI tools untouched");
  }
}

async function uninstallCliTools(ctx: Context): Promise<void> {
  await revertCliTools(ctx, getPluginActions(ctx));
}

export const cliToolPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "executes",
  sharedResources: CLI_TOOL_BUNDLE.map((entry) => entry.sharedResource),
  detect: detectCliTools,
  describeState: describeCliToolsState,
  plan: planCliTools,
  apply: applyCliTools,
  install: installCliTools,
  verify: verifyCliTools,
  revert: revertCliTools,
  uninstall: uninstallCliTools,
};
