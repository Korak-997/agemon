import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../core/context.js";
import { errorMessage } from "../../core/error-message.js";
import {
  assertLinkPathIsFree,
  inspectLinkedBinary,
  isDirectoryOnPath,
  type LinkedBinaryPaths,
  linkedBinaryPaths,
  unlinkBinary,
} from "../../core/linked-binary.js";
import { readMachineLedger } from "../../core/machine-ledger.js";
import { resolveGlobalNpmRoot } from "../../core/npm-global.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { resolveAgemonStateDirectory } from "../../core/state-root.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";
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
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  PluginWithInstall,
  ProposedOperation,
} from "../types.js";
import {
  CLI_TOOL_BUNDLE,
  type CliToolBundleEntry,
  type NpmWrappedInstall,
} from "./catalog.js";

const PLUGIN_ID = "cli-tool";

const ACTION_TYPE_INSTALLED_CLI_TOOL = "installed-cli-tool";
const ACTION_TYPE_PREEXISTING_CLI_TOOL = "preexisting-cli-tool";

const VERSION_CHECK_TIMEOUT_MS = 20_000;
const UNINSTALL_TIMEOUT_MS = 60_000;

export function pinnedArchiveKeyFor(platform: PlatformCapabilities): string {
  return `${platform.family}-${platform.arch}`;
}

function hasPinnedBuild(
  entry: CliToolBundleEntry,
  platform: PlatformCapabilities,
): boolean {
  return Object.hasOwn(
    entry.releaseArchivesByPlatform,
    pinnedArchiveKeyFor(platform),
  );
}

export function toolsWithPinnedBuild(
  platform: PlatformCapabilities,
): CliToolBundleEntry[] {
  return CLI_TOOL_BUNDLE.filter((entry) => hasPinnedBuild(entry, platform));
}

export function toolsWithoutPinnedBuild(
  platform: PlatformCapabilities,
): CliToolBundleEntry[] {
  return CLI_TOOL_BUNDLE.filter((entry) => !hasPinnedBuild(entry, platform));
}

export function resolveVerifiedArchiveCandidates(
  entry: CliToolBundleEntry,
  platformKey: string,
): VerifiedArchiveCandidate[] {
  const archives = Object.hasOwn(entry.releaseArchivesByPlatform, platformKey)
    ? entry.releaseArchivesByPlatform[platformKey]
    : undefined;
  if (!archives) {
    throw new Error(`${entry.id} has no pinned build for ${platformKey}.`);
  }
  return archives;
}

function pinnedPackageSpec(
  entry: CliToolBundleEntry,
  npm: NpmWrappedInstall,
): string {
  return `${npm.packageName}@${entry.version}`;
}

function linkedPathsOf(entry: CliToolBundleEntry): LinkedBinaryPaths {
  return linkedBinaryPaths(entry.id, entry.version, entry.binaryName);
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function isManagedInstallOf(action: LedgerEntry, toolId: string): boolean {
  return (
    action.type === ACTION_TYPE_INSTALLED_CLI_TOOL &&
    action.target === toolId &&
    action.preExisting === false
  );
}

function hasManagedInstallRecord(ctx: Context, toolId: string): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      isManagedInstallOf(action, toolId) && ctx.manifest.isConfirmed(action),
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
  npm: NpmWrappedInstall,
  options: { fresh?: boolean } = {},
): Promise<InstalledPackageInspection> {
  const inspections = inspectionsByContext.get(ctx) ?? new Map();
  inspectionsByContext.set(ctx, inspections);
  const cached = options.fresh ? undefined : inspections.get(entry.id);
  if (cached) {
    return cached;
  }
  const inspection = ctx.verifiedBinaryInstaller.inspect({
    packageName: npm.packageName,
    commandName: entry.binaryName,
    commandPathInPackage: npm.commandPathInPackage,
    binaryPathInPackage: npm.binaryPathInPackage,
    packageFileSha256: npm.packageFileSha256,
    binarySha256: npm.binarySha256,
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
  npm: NpmWrappedInstall,
): Promise<string[]> {
  if (!(await isInstalledByAgemon(ctx, entry))) {
    return [];
  }
  const inspection = await inspectInstalledTool(ctx, entry, npm);
  return inspection.kind === "installed" ? inspection.differences : [];
}

async function isToolBinaryAvailable(
  ctx: Context,
  entry: CliToolBundleEntry,
  options: { fresh?: boolean } = {},
): Promise<boolean> {
  let versionCommand = entry.binaryName;
  if (await isInstalledByAgemon(ctx, entry)) {
    if (entry.install.kind === "linked-binary") {
      const paths = linkedPathsOf(entry);
      if ((await inspectLinkedBinary(paths)) !== "ours-current") {
        return false;
      }
      versionCommand = paths.linkPath;
    } else {
      const inspection = await inspectInstalledTool(
        ctx,
        entry,
        entry.install,
        options,
      );
      if (inspection.kind === "absent") {
        return false;
      }
      if (inspection.differences.length > 0) {
        return true;
      }
    }
  }
  const result = await ctx.run(versionCommand, ["--version"], {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  return result.code === 0;
}

async function detectCliTools(ctx: Context): Promise<PluginPresence> {
  const offeredTools = toolsWithPinnedBuild(ctx.platform);
  for (const entry of offeredTools) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      return { present: false, preExisting: false };
    }
  }
  const allManaged = offeredTools.every((entry) =>
    hasManagedInstallRecord(ctx, entry.id),
  );
  return { present: true, preExisting: !allManaged };
}

async function describeCliToolsState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  return Promise.all(
    toolsWithPinnedBuild(ctx.platform).map(
      async (entry): Promise<CapabilityStateRow> => {
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
        const installed = await describeInstalledCopy(ctx, entry, managed);
        return {
          capabilityId: PLUGIN_ID,
          resourceId,
          label: entry.binaryName,
          state: managed ? "present-managed" : "present-adopted",
          detail: managed
            ? `${entry.install.kind === "npm-wrapped" ? "installed via npm" : "linked from a verified release archive"} (${installed})`
            : `pre-existing install (${installed})`,
        };
      },
    ),
  );
}

async function describeInstalledCopy(
  ctx: Context,
  entry: CliToolBundleEntry,
  managed: boolean,
): Promise<string> {
  if (entry.install.kind === "linked-binary") {
    return managed
      ? `${entry.binaryName} ${entry.version} at ${linkedPathsOf(entry).linkPath}`
      : entry.binaryName;
  }
  const { packageName } = entry.install;
  const inspection = await inspectInstalledTool(ctx, entry, entry.install);
  return inspection.kind !== "installed"
    ? packageName
    : inspection.version === null
      ? `${packageName}; agemon could not inspect it (${inspection.differences.join("; ")})`
      : `${packageName} ${inspection.version}${inspection.differences.length > 0 ? `, not the pinned ${entry.version} build` : ""}`;
}

function describeInstallOperation(
  entry: CliToolBundleEntry,
): ProposedOperation {
  const paths = linkedPathsOf(entry);
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: `package:${entry.id}`,
    targetPath:
      entry.install.kind === "npm-wrapped"
        ? entry.install.packageName
        : paths.linkPath,
    action: "install-package",
    riskClass: "executes",
    requiresConsent: true,
    preview: {
      kind: "note",
      text:
        entry.install.kind === "npm-wrapped"
          ? `npm install --global --ignore-scripts of the sha512-pinned ${pinnedPackageSpec(entry, entry.install)} tarball; binary from the v${entry.version} GitHub release, sha256-pinned`
          : `sha256-pinned ${entry.binaryName} ${entry.version} release binary, installed under ${paths.toolsRoot} and linked as ${paths.linkPath}`,
    },
  });
}

async function planCliTools(ctx: Context): Promise<ProposedOperation[]> {
  const operations: ProposedOperation[] = [];
  for (const entry of toolsWithPinnedBuild(ctx.platform)) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      operations.push(describeInstallOperation(entry));
    } else if (
      !(
        entriesForTool(ctx, getPluginActions(ctx), entry).usesIt &&
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
      `npm global uninstall failed for ${printable(packageName)}: ${describeSubprocessFailure(uninstallResult, "npm uninstall")}`,
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
  npm: NpmWrappedInstall,
): Promise<void> {
  const npmRoot = await resolveGlobalNpmRoot(ctx.run, {
    cwd: (await resolveAgemonStateDirectory("prepare")).path,
    mayNotExistYet: true,
  });
  const packagePath = join(npmRoot, npm.packageName);
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
      ? `${npm.packageName} is installed but '${entry.binaryName} --version' fails on your PATH (it is recorded in the shared-tools ledger); fix your PATH, then run agemon again.`
      : `A global npm ${npm.packageName} already exists at ${printable(packagePath)} but '${entry.binaryName} --version' fails on your PATH — fix it or run 'npm uninstall --global ${npm.packageName}', then run agemon again.`,
  );
}

async function installNpmWrappedTool(
  ctx: Context,
  entry: CliToolBundleEntry,
  npm: NpmWrappedInstall,
): Promise<void> {
  await assertNoForeignGlobalPackage(ctx, entry, npm);
  const candidates = resolveVerifiedArchiveCandidates(
    entry,
    pinnedArchiveKeyFor(ctx.platform),
  );
  try {
    await ctx.verifiedBinaryInstaller.install({
      packageName: npm.packageName,
      version: entry.version,
      binaryPathInPackage: npm.binaryPathInPackage,
      candidates,
      packageTarball: npm.packageTarball,
    });
  } catch (installError) {
    await removePartlyInstalledPackage(ctx, npm.packageName, installError);
    throw new Error(
      `${errorMessage(installError)} agemon uninstalled the global npm package ${npm.packageName} again, so nothing is left half-installed.`,
      { cause: installError },
    );
  }
}

async function installLinkedTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  const paths = linkedPathsOf(entry);
  await assertLinkPathIsFree(paths);
  await ctx.verifiedBinaryInstaller.installLinked({
    candidates: resolveVerifiedArchiveCandidates(
      entry,
      pinnedArchiveKeyFor(ctx.platform),
    ),
    paths,
    version: entry.version,
  });
  const linkDirectory = dirname(paths.linkPath);
  if (!(await isDirectoryOnPath(linkDirectory))) {
    ctx.ui.info(
      `${linkDirectory} is not on your PATH; add it to use ${entry.binaryName}`,
    );
  }
}

function installPinnedCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  return entry.install.kind === "npm-wrapped"
    ? installNpmWrappedTool(ctx, entry, entry.install)
    : installLinkedTool(ctx, entry);
}

async function installSharedCliTool(
  ctx: Context,
  entry: CliToolBundleEntry,
): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(
      entry.install.kind === "npm-wrapped"
        ? `Would install the sha512-pinned ${pinnedPackageSpec(entry, entry.install)} tarball globally via npm, with its sha256-pinned binary`
        : `Would install the sha256-pinned ${entry.binaryName} ${entry.version} release binary and link it as ${linkedPathsOf(entry).linkPath}`,
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
  for (const entry of toolsWithPinnedBuild(ctx.platform)) {
    if (!(await isToolBinaryAvailable(ctx, entry))) {
      await installSharedCliTool(ctx, entry);
    }
  }
}

async function applyCliTools(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<undefined> {
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

  const offeredTools = toolsWithPinnedBuild(ctx.platform);
  const missingToolIds: string[] = [];
  for (const entry of offeredTools) {
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
  for (const entry of offeredTools) {
    if (entry.install.kind !== "npm-wrapped") {
      continue;
    }
    const { packageName } = entry.install;
    const differences = await unpinnedFilesOfAgemonInstall(
      ctx,
      entry,
      entry.install,
    );
    if (differences.length > 0) {
      attention.push(
        `${entry.binaryName} is not the pinned ${packageName} ${entry.version} build (${differences.join("; ")}); reinstall it: npm uninstall --global ${packageName}, then run agemon`,
      );
    }
  }

  return {
    ok: true,
    detail: `${offeredTools.length} CLI tool bundle entries present`,
    ...(attention.length > 0 ? { attention: attention.join(" ") } : {}),
  };
}

function entriesForTool(
  ctx: Context,
  entries: LedgerEntry[],
  entry: CliToolBundleEntry,
): { installedIt: boolean; usesIt: boolean } {
  const installEntries = entries.filter((action) =>
    isManagedInstallOf(action, entry.id),
  );
  const installedIt = installEntries.some((action) =>
    ctx.manifest.isConfirmed(action),
  );
  const usesIt =
    installEntries.length > 0 ||
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
    const { installedIt, usesIt } = entriesForTool(ctx, entries, entry);
    if (!usesIt) {
      continue;
    }
    releasedAny = true;
    await releaseSharedResource(ctx, entry.sharedResource, {
      releasingRepoInstalledIt: installedIt,
      isPresent: async () => true,
      remove: async () => {
        if (entry.install.kind === "npm-wrapped") {
          await uninstallGlobalPackage(ctx, entry.install.packageName);
        } else {
          await unlinkBinary(linkedPathsOf(entry));
        }
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

export const cliToolPlugin: PluginWithInstall = {
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
