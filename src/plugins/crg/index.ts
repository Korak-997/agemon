import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
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
} from "../shared-resource.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  SharedResourceDeclaration,
} from "../types.js";
import { ensureCrgConstraintsFile, hashLockedPipArgs } from "./constraints.js";
import { crgSubprocessEnvironment, resolveCrgHome } from "./environment.js";
import {
  BROKEN_PIPX_VENV_HINT,
  type CrgLocation,
  locateCodeReviewGraph,
  pipxMetadataPath,
  resolvePipxHome,
} from "./locate.js";

const PLUGIN_ID = "crg";
const PACKAGE_NAME = "code-review-graph";
const GRAPH_DIRECTORY = ".code-review-graph";

const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 30_000;
const UNINSTALL_TIMEOUT_MS = 120_000;

const ACTION_TYPE_INSTALLED_BINARY = "installed-binary";
const ACTION_TYPE_GRAPH_BUILT = "graph-built";

const GRAPH_ENTRY_NOT_DIRECTORY = `${GRAPH_DIRECTORY} is a symlink or file, not a directory; remove it, then run code-review-graph build`;
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

function hasManagedInstall(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_BINARY &&
      action.preExisting === false,
  );
}

function describeLocation(
  location: Extract<CrgLocation, { status: "found" }>,
): string {
  const installedAs =
    location.source === "pipx"
      ? `pipx ${location.version}`
      : `${printable(location.binaryPath)} ${location.version}`;
  return location.onPath ? installedAs : `${installedAs}; ${NOT_ON_PATH_HINT}`;
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

type GraphEntryKind = "missing" | "directory" | "other";

async function graphEntryKind(ctx: Context): Promise<GraphEntryKind> {
  try {
    const stats = await lstat(join(ctx.cwd, GRAPH_DIRECTORY));
    return stats.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

function reportIgnoredCrgEnvironment(ctx: Context): void {
  if (process.env.CRG_HOME || process.env.CRG_DATA_DIR) {
    ctx.ui.info(
      `CRG_HOME and CRG_DATA_DIR from your environment are not used here: agemon's managed graph lives in ${GRAPH_DIRECTORY}/ and code-review-graph's home is ${printable(resolveCrgHome())}`,
    );
  }
}

async function isCrgInstalled(ctx: Context): Promise<boolean> {
  return (await locateCodeReviewGraph(ctx)).status === "found";
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
  if (installResult.code !== 0) {
    throw new Error(
      printable(installResult.stderr) ||
        `pipx install failed for ${CODE_REVIEW_GRAPH_PACKAGE_SPEC}`,
    );
  }
}

async function installCrg(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`Would install ${PACKAGE_NAME} via pipx`);
    ctx.ui.info("Would build graph for current repository");
    return;
  }

  const pipxHome = await resolvePipxHome();
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

  const graphEntry = await graphEntryKind(ctx);
  if (graphEntry === "other") {
    ctx.ui.info(`skipped the graph build: ${GRAPH_ENTRY_NOT_DIRECTORY}`);
    return;
  }

  reportIgnoredCrgEnvironment(ctx);
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_GRAPH_BUILT,
    target: GRAPH_DIRECTORY,
    preExisting: graphEntry === "directory",
  });
  const buildResult = await ctx.run(location.binaryPath, ["build"], {
    timeoutMs: BUILD_TIMEOUT_MS,
    env: crgSubprocessEnvironment(),
  });
  if (buildResult.code !== 0) {
    throw new Error(buildResult.stderr || "code-review-graph build failed");
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
): Promise<void> {
  for (const operation of operations) {
    if (operation.action === "use-shared") {
      await useInstalledCrg(ctx);
    } else if (operation.action === "install-package") {
      await installCrg(ctx);
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

  const graphEntry = await graphEntryKind(ctx);
  if (graphEntry === "other") {
    return { ok: false, detail: GRAPH_ENTRY_NOT_DIRECTORY };
  }
  if (graphEntry === "missing") {
    return entriesHaveBuiltGraph(getPluginActions(ctx))
      ? {
          ok: false,
          detail: `${GRAPH_DIRECTORY}/ is missing — run agemon to build it again`,
        }
      : { ok: true, detail: "installed; no graph built in this repository" };
  }

  const statusResult = await ctx.run(location.binaryPath, ["status"], {
    timeoutMs: STATUS_TIMEOUT_MS,
    env: crgSubprocessEnvironment(),
  });
  if (statusResult.code !== 0) {
    return {
      ok: false,
      detail:
        printable(statusResult.stderr) || "code-review-graph status failed",
    };
  }

  return { ok: true, detail: "status command passed" };
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
  const managedInstall = entriesHaveManagedInstall(entries);
  const usesSharedCrg =
    managedInstall ||
    repoLedgerUsesSharedResource(entries, CRG_SHARED_RESOURCE);
  const builtGraph = entriesHaveBuiltGraph(entries);

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
          env: { PIPX_HOME: await resolvePipxHome() },
        },
      );
      if (uninstallResult.code !== 0) {
        throw new Error(
          printable(uninstallResult.stderr) ||
            `pipx uninstall failed for ${PACKAGE_NAME}`,
        );
      }
    },
  });
}

async function uninstallCrg(ctx: Context): Promise<void> {
  await revertCrg(ctx, getPluginActions(ctx));
}

export const crgPlugin: AgemonPlugin = {
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
