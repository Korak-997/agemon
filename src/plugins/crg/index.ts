import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";
import {
  assertGitConfigMatchesPlan,
  joinAttention,
  markUntrustedGitConfig,
  UNTRUSTED_GIT_CONFIG_REMEDY,
  verifyRepositoryGitConfig,
} from "../../core/untrusted-git-config.js";
import { printable } from "../../core/untrusted-text.js";
import { CODE_REVIEW_GRAPH_PACKAGE_SPEC } from "../pins.js";
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
  SharedResourceDeclaration,
} from "../types.js";
import { ensureCrgConstraintsFile, hashLockedPipArgs } from "./constraints.js";
import {
  crgRepositoryEnvironment,
  REPOSITORY_LOCAL_VARIABLES_REMOVED_FOR_CRG,
  resolveCrgHome,
} from "./environment.js";
import { GRAPH_DIRECTORY, graphDirectoryProblem } from "./graph-directory.js";
import {
  BROKEN_PIPX_VENV_HINT,
  type CrgLocation,
  locateCodeReviewGraph,
  pipxMetadataPath,
  resolvePipxHome,
} from "./locate.js";

const PLUGIN_ID = "crg";
const PACKAGE_NAME = "code-review-graph";

const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 30_000;
const UNINSTALL_TIMEOUT_MS = 120_000;

const ACTION_TYPE_INSTALLED_BINARY = "installed-binary";
const ACTION_TYPE_GRAPH_BUILT = "graph-built";

const PIPX_NOT_FOUND = /process spawn error: spawn pipx ENOENT/;
const NOT_ON_PATH_HINT =
  "not on PATH — run 'pipx ensurepath' and open a new shell";

const CRG_SHARED_RESOURCE: SharedResourceDeclaration = {
  id: "pipx:code-review-graph",
  toolName: PACKAGE_NAME,
  manualRemoveCommand: `pipx uninstall ${PACKAGE_NAME}`,
  removalVerb: "uninstall",
  migratesFromRepoLedgers: true,
};

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function confirmedPluginActions(ctx: Context): LedgerEntry[] {
  return getPluginActions(ctx).filter((action) =>
    ctx.manifest.isConfirmed(action),
  );
}

function hasManagedInstall(ctx: Context): boolean {
  return entriesHaveManagedInstall(confirmedPluginActions(ctx));
}

type FoundCrg = Extract<CrgLocation, { status: "found" }>;

function describeLocation(location: FoundCrg): string {
  const installedAs =
    location.source === "pipx"
      ? `pipx ${location.version}`
      : `${printable(location.binaryPath)} ${location.version}`;
  const locked = location.hashLocked
    ? installedAs
    : `${installedAs}; dependencies not hash-locked`;
  return location.onPath ? locked : `${locked}; ${NOT_ON_PATH_HINT}`;
}

async function hashLockAttention(
  ctx: Context,
  location: FoundCrg,
): Promise<{ attention?: string }> {
  if (
    location.hashLocked ||
    !(await wasInstalledByAgemon(CRG_SHARED_RESOURCE, hasManagedInstall(ctx)))
  ) {
    return {};
  }
  return {
    attention:
      location.source === "pipx"
        ? `${PACKAGE_NAME}'s dependencies are not hash-locked (installed by an older agemon, by hand, or rewritten by 'pipx upgrade'); reinstall it: pipx uninstall ${PACKAGE_NAME}, then run agemon`
        : `${PACKAGE_NAME} at ${printable(location.binaryPath)} is not a pipx install agemon can check for hash-locked dependencies; remove it, then run agemon to install the hash-locked one`,
  };
}

async function detectCrgPresence(ctx: Context): Promise<PluginPresence> {
  const location = await locateCodeReviewGraph(ctx);
  if (location.status === "absent") {
    return { present: false, preExisting: false };
  }
  return { present: true, preExisting: !hasManagedInstall(ctx) };
}

async function describeCrgState(ctx: Context): Promise<CapabilityStateRow[]> {
  const location = await locateCodeReviewGraph(ctx);
  const row = {
    capabilityId: PLUGIN_ID,
    resourceId: `package:${PACKAGE_NAME}`,
    label: PACKAGE_NAME,
  };

  if (location.status === "absent") {
    return [{ ...row, state: "absent", detail: null }];
  }
  if (location.status === "broken-venv") {
    return [{ ...row, state: "unknown", detail: BROKEN_PIPX_VENV_HINT }];
  }
  return [
    {
      ...row,
      state: hasManagedInstall(ctx) ? "present-managed" : "present-adopted",
      detail: describeLocation(location),
    },
  ];
}

async function planCrg(ctx: Context): Promise<ProposedOperation[]> {
  return markUntrustedGitConfig(ctx, await planCrgOperations(ctx), {
    runsGit: () => true,
    reportsUnreadableConfig: true,
  });
}

async function planCrgOperations(ctx: Context): Promise<ProposedOperation[]> {
  const location = await locateCodeReviewGraph(ctx);
  if (location.status === "broken-venv") {
    ctx.ui.info(BROKEN_PIPX_VENV_HINT);
    return [];
  }
  if (location.status === "found") {
    if (!location.onPath) {
      ctx.ui.info(
        `${PACKAGE_NAME} is installed via pipx but ${NOT_ON_PATH_HINT}`,
      );
    }
    const ledgerRecordsUse =
      hasManagedInstall(ctx) ||
      repoLedgerUsesSharedResource(getPluginActions(ctx), CRG_SHARED_RESOURCE);
    return ledgerRecordsUse &&
      (await isHeldByThisRepository(ctx, CRG_SHARED_RESOURCE))
      ? []
      : [
          describeUseSharedOperation(
            PLUGIN_ID,
            CRG_SHARED_RESOURCE,
            hasManagedInstall(ctx),
          ),
        ];
  }

  return [
    describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: `package:${PACKAGE_NAME}`,
      targetPath: PACKAGE_NAME,
      action: "install-package",
      riskClass: "executes",
      requiresConsent: true,
      preview: {
        kind: "note",
        text: `pipx install ${CODE_REVIEW_GRAPH_PACKAGE_SPEC} (dependencies hash-locked); build the code graph for this repository`,
      },
    }),
  ];
}

async function graphDirectoryExists(ctx: Context): Promise<boolean> {
  try {
    await lstat(join(ctx.cwd, GRAPH_DIRECTORY));
    return true;
  } catch {
    return false;
  }
}

function reportIgnoredCrgEnvironment(ctx: Context): void {
  if (
    process.env.CRG_HOME ||
    process.env.CRG_DATA_DIR ||
    process.env.CRG_REPO_ROOT
  ) {
    ctx.ui.info(
      `CRG_HOME, CRG_DATA_DIR and CRG_REPO_ROOT from your environment are not used here: agemon's managed graph lives in ${GRAPH_DIRECTORY}/ and code-review-graph's home is ${printable(resolveCrgHome())}`,
    );
  }
}

async function isCrgInstalled(ctx: Context): Promise<boolean> {
  return (await locateCodeReviewGraph(ctx)).status === "found";
}

function describeMissingPipx(ctx: Context): string {
  const installHint =
    ctx.platform.family === "darwin"
      ? "install it with 'brew install pipx' and make sure Homebrew's bin directory is on PATH (eval \"$(brew shellenv)\")"
      : "install it with 'sudo apt install pipx'";
  return `pipx is not on PATH, so ${PACKAGE_NAME} cannot be installed; ${installHint}, then run agemon again.`;
}

async function pipxInstallCrg(ctx: Context, pipxHome: string): Promise<void> {
  const constraintsPath = await ensureCrgConstraintsFile();
  const installResult = await ctx.run(
    "pipx",
    [
      "install",
      CODE_REVIEW_GRAPH_PACKAGE_SPEC,
      hashLockedPipArgs(constraintsPath),
    ],
    { timeoutMs: INSTALL_TIMEOUT_MS, env: { PIPX_HOME: pipxHome } },
  );
  if (PIPX_NOT_FOUND.test(installResult.stderr)) {
    throw new Error(describeMissingPipx(ctx));
  }
  if (installResult.code !== 0) {
    throw new Error(
      `pipx install failed for ${CODE_REVIEW_GRAPH_PACKAGE_SPEC}: ${describeSubprocessFailure(installResult, "pipx")}`,
    );
  }
}

async function installCrg(
  ctx: Context,
  operation?: ProposedOperation,
): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would install ${PACKAGE_NAME} via pipx`);
    ctx.ui.info("Would build graph for current repository");
    return;
  }

  const pipxHome = await resolvePipxHome(ctx.platform.family);
  const outcome = await createSharedResource(
    ctx,
    PLUGIN_ID,
    CRG_SHARED_RESOURCE,
    {
      isPresent: () => isCrgInstalled(ctx),
      create: () => pipxInstallCrg(ctx, pipxHome),
      async recordInstall() {
        await ctx.manifest.recordAction({
          plugin: PLUGIN_ID,
          type: ACTION_TYPE_INSTALLED_BINARY,
          target: `${PACKAGE_NAME} (pipx)`,
          preExisting: false,
        });
      },
    },
  );
  if (outcome === "already-present") {
    return;
  }

  const location = await locateCodeReviewGraph(ctx);
  if (location.status === "broken-venv") {
    throw new Error(`pipx reported success but the ${BROKEN_PIPX_VENV_HINT}`);
  }
  if (location.status !== "found") {
    throw new Error(
      `pipx reported success but ${pipxMetadataPath(pipxHome)} is missing or invalid`,
    );
  }

  const graphProblem = await graphDirectoryProblem(ctx.cwd);
  if (graphProblem !== null) {
    ctx.ui.info(`skipped the graph build: ${graphProblem}`);
    return;
  }

  reportIgnoredCrgEnvironment(ctx);
  await assertGitConfigMatchesPlan(ctx.gitConfigGuard, operation);
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_GRAPH_BUILT,
    target: GRAPH_DIRECTORY,
    preExisting: await graphDirectoryExists(ctx),
  });
  const buildResult = await ctx.run(location.binaryPath, ["build"], {
    timeoutMs: BUILD_TIMEOUT_MS,
    env: crgRepositoryEnvironment(ctx.cwd),
    unsetEnv: REPOSITORY_LOCAL_VARIABLES_REMOVED_FOR_CRG,
  });
  if (buildResult.code !== 0) {
    throw new Error(
      `code-review-graph build failed: ${describeSubprocessFailure(buildResult, "code-review-graph build")}`,
    );
  }
}

async function useInstalledCrg(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would record that this repository uses ${PACKAGE_NAME}`);
    return;
  }
  await addSharedHolder(ctx, PLUGIN_ID, CRG_SHARED_RESOURCE, {
    isPresent: () => isCrgInstalled(ctx),
    repoLedgerSaysInstalled: hasManagedInstall(ctx),
  });
}

async function applyCrg(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<undefined> {
  for (const operation of operations) {
    if (operation.action === "use-shared") {
      await useInstalledCrg(ctx);
    } else if (operation.action === "install-package") {
      await installCrg(ctx, operation);
    }
  }
}

async function verifyCrg(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const location = await locateCodeReviewGraph(ctx);
  if (location.status === "broken-venv") {
    return { ok: false, detail: BROKEN_PIPX_VENV_HINT };
  }
  if (location.status === "absent") {
    return { ok: false, detail: `${PACKAGE_NAME} is not installed` };
  }

  const gitConfig = await verifyRepositoryGitConfig(ctx.gitConfigGuard);
  if (gitConfig.kind === "unreadable") {
    return { ok: false, detail: gitConfig.detail };
  }
  const gitConfigAttention =
    gitConfig.kind === "untrusted"
      ? `this repository's git config has keys agemon does not trust by default: ${gitConfig.untrustedKeys}; ${PACKAGE_NAME} runs git here. ${UNTRUSTED_GIT_CONFIG_REMEDY}`
      : undefined;

  const graphProblem = await graphDirectoryProblem(ctx.cwd);
  if (graphProblem !== null) {
    return { ok: false, detail: graphProblem };
  }
  if (!(await graphDirectoryExists(ctx))) {
    return entriesHaveBuiltGraph(confirmedPluginActions(ctx))
      ? {
          ok: false,
          detail: `${GRAPH_DIRECTORY}/ is missing — run agemon to build it again`,
        }
      : {
          ok: true,
          detail: "installed; no graph built in this repository",
          ...joinAttention(
            (await hashLockAttention(ctx, location)).attention,
            gitConfigAttention,
          ),
        };
  }
  if (gitConfigAttention !== undefined) {
    return {
      ok: true,
      detail: `installed; ${PACKAGE_NAME} status not run`,
      ...joinAttention(
        (await hashLockAttention(ctx, location)).attention,
        gitConfigAttention,
      ),
    };
  }

  const statusResult = await ctx.run(location.binaryPath, ["status"], {
    timeoutMs: STATUS_TIMEOUT_MS,
    env: crgRepositoryEnvironment(ctx.cwd),
    unsetEnv: REPOSITORY_LOCAL_VARIABLES_REMOVED_FOR_CRG,
  });
  if (statusResult.code !== 0) {
    return {
      ok: false,
      detail: `code-review-graph status failed: ${describeSubprocessFailure(statusResult, "code-review-graph status")}`,
    };
  }

  return {
    ok: true,
    detail: "status command passed",
    ...(await hashLockAttention(ctx, location)),
  };
}

function entriesHaveManagedInstall(entries: LedgerEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === ACTION_TYPE_INSTALLED_BINARY &&
      entry.preExisting === false,
  );
}

function entriesHaveBuiltGraph(entries: LedgerEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === ACTION_TYPE_GRAPH_BUILT &&
      entry.preExisting === false &&
      entry.target === GRAPH_DIRECTORY,
  );
}

async function removeBuiltGraph(ctx: Context): Promise<void> {
  const graphPath = join(ctx.cwd, GRAPH_DIRECTORY);
  let graphStats: Awaited<ReturnType<typeof lstat>>;
  try {
    graphStats = await lstat(graphPath);
  } catch {
    ctx.ui.info(
      `no ${GRAPH_DIRECTORY} in the repository; a graph kept elsewhere by crg's registry is not removed`,
    );
    return;
  }

  if (!graphStats.isDirectory()) {
    ctx.ui.info(
      `left ${GRAPH_DIRECTORY} in place: it is a symlink or file, not the directory agemon built; remove it by hand if you no longer need it`,
    );
    return;
  }
  await rm(graphPath, { recursive: true, force: true });
}

async function revertCrg(ctx: Context, entries: LedgerEntry[]): Promise<void> {
  const confirmedEntries = entries.filter((entry) =>
    ctx.manifest.isConfirmed(entry),
  );
  const managedInstall = entriesHaveManagedInstall(confirmedEntries);
  const usesSharedCrg =
    entriesHaveManagedInstall(entries) ||
    repoLedgerUsesSharedResource(entries, CRG_SHARED_RESOURCE);
  const builtGraph = entriesHaveBuiltGraph(confirmedEntries);

  if (!builtGraph && entriesHaveBuiltGraph(entries)) {
    ctx.ui.info(
      `${ctx.dryRun ? "Would keep" : "Keeping"} ${GRAPH_DIRECTORY}/: agemon has no record on this machine that it built it here`,
    );
  }
  if (builtGraph) {
    if (ctx.dryRun) {
      ctx.ui.info(
        `Would remove ${GRAPH_DIRECTORY}/ (code graph, wiki/exports, embeddings — rebuildable with code-review-graph build)`,
      );
    } else {
      await removeBuiltGraph(ctx);
    }
  }
  if (!usesSharedCrg) {
    if (ctx.dryRun) {
      ctx.ui.info(`Would keep pre-existing ${PACKAGE_NAME} install`);
    }
    return;
  }

  await releaseSharedResource(ctx, CRG_SHARED_RESOURCE, {
    releasingRepoInstalledIt: managedInstall,
    isPresent: async () =>
      (await locateCodeReviewGraph(ctx)).status !== "absent",
    async remove() {
      const uninstallResult = await ctx.run(
        "pipx",
        ["uninstall", PACKAGE_NAME],
        {
          timeoutMs: UNINSTALL_TIMEOUT_MS,
          env: { PIPX_HOME: await resolvePipxHome(ctx.platform.family) },
        },
      );
      if (uninstallResult.code !== 0) {
        throw new Error(
          `pipx uninstall failed for ${PACKAGE_NAME}: ${describeSubprocessFailure(uninstallResult, "pipx")}`,
        );
      }
    },
  });
}

async function uninstallCrg(ctx: Context): Promise<void> {
  await revertCrg(ctx, getPluginActions(ctx));
}

export const crgPlugin: PluginWithInstall = {
  id: PLUGIN_ID,
  riskClass: "executes",
  sharedResources: [CRG_SHARED_RESOURCE],
  detect: detectCrgPresence,
  describeState: describeCrgState,
  plan: planCrg,
  apply: applyCrg,
  install: installCrg,
  verify: verifyCrg,
  revert: revertCrg,
  uninstall: uninstallCrg,
};
