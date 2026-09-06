import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IsolationStatus } from "../inspect/discover.js";
import type {
  AgemonPlugin,
  ProposedOperation,
  StagedFile,
} from "../plugins/types.js";
import { writeImmutableBackup } from "./backups.js";
import type { Context } from "./context.js";
import { fingerprintContent } from "./fingerprint.js";
import { writeAgemonGitignoreEntry } from "./gitignore.js";
import { type Plan, writePlan } from "./plan-store.js";
import type { LedgerEntry } from "./state-manifest.js";

const FILE_TARGETING_ACTIONS: ReadonlySet<ProposedOperation["action"]> =
  new Set(["create", "replace", "merge-block", "merge-key", "adopt"]);

export interface ApplyPlanInput {
  plan: Plan;
  approved: ProposedOperation[];
  workspaceIsolationApproved: boolean | null;
  isolationStatus: IsolationStatus;
  allowUnignoredState: boolean;
}

export interface ApplyPlanResult {
  applied: ProposedOperation[];
}

export interface RollbackDetail {
  message: string;
  restored: string[];
  reverted: string[];
  manualCleanup: string[];
}

export class ApplyRollbackError extends Error {
  readonly rollback: RollbackDetail;

  constructor(rollback: RollbackDetail) {
    super(rollback.message);
    this.name = "ApplyRollbackError";
    this.rollback = rollback;
  }
}

interface FileRollbackSnapshot {
  targetPath: string;
  previousContents: string | null;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeStagedFileName(targetPath: string): string {
  return encodeURIComponent(targetPath);
}

function validateManagedMarkerBalance(staged: StagedFile): string | null {
  const markerPattern = /<!-- agemon:(start|end):([A-Za-z0-9_-]+) -->/gu;
  const startCounts = new Map<string, number>();
  const endCounts = new Map<string, number>();
  const seenStart = new Set<string>();

  for (
    let match = markerPattern.exec(staged.contents);
    match !== null;
    match = markerPattern.exec(staged.contents)
  ) {
    const [, kind, blockId] = match;
    if (kind === "start") {
      startCounts.set(blockId, (startCounts.get(blockId) ?? 0) + 1);
      seenStart.add(blockId);
    } else {
      if (!seenStart.has(blockId)) {
        return `${staged.targetPath}: agemon end marker for '${blockId}' precedes its start marker`;
      }
      endCounts.set(blockId, (endCounts.get(blockId) ?? 0) + 1);
    }
  }

  for (const [blockId, starts] of startCounts) {
    const ends = endCounts.get(blockId) ?? 0;
    if (starts !== 1 || ends !== 1) {
      return `${staged.targetPath}: agemon block '${blockId}' markers unbalanced (${starts} start, ${ends} end)`;
    }
  }

  return null;
}

function validateStagedFile(staged: StagedFile): string | null {
  if (staged.kind === "json") {
    try {
      JSON.parse(staged.contents);
    } catch (error) {
      return `${staged.targetPath}: invalid JSON — ${errorMessage(error)}`;
    }
    return null;
  }
  if (staged.kind === "markdown") {
    return validateManagedMarkerBalance(staged);
  }
  return null;
}

async function stageApprovedFiles(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  planId: string,
  approvedByCapability: Map<string, ProposedOperation[]>,
): Promise<Map<string, StagedFile[]>> {
  const stagedByCapability = new Map<string, StagedFile[]>();
  const stagedRoot = join(ctx.cwd, ".agemon", "plans", planId, "staged");
  let stagedRootCreated = false;

  for (const [capabilityId, operations] of approvedByCapability) {
    const plugin = pluginById.get(capabilityId);
    if (!plugin?.materialize) {
      continue;
    }

    const stagedFiles = await plugin.materialize(ctx, operations);
    if (stagedFiles.length === 0) {
      continue;
    }

    if (!stagedRootCreated) {
      await mkdir(stagedRoot, { recursive: true });
      stagedRootCreated = true;
    }

    for (const staged of stagedFiles) {
      await writeFile(
        join(stagedRoot, encodeStagedFileName(staged.targetPath)),
        staged.contents,
        "utf8",
      );
      const problem = validateStagedFile(staged);
      if (problem !== null) {
        throw new Error(
          `Refusing to apply plan ${planId}: staged file failed validation — ${problem}`,
        );
      }
    }

    stagedByCapability.set(capabilityId, stagedFiles);
  }

  return stagedByCapability;
}

async function revertCommittedCapabilities(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  appliedCapabilityOrder: string[],
  ledgerActionIdsBeforeRun: ReadonlySet<string>,
): Promise<{ reverted: string[]; manualCleanup: string[] }> {
  const newEntriesByCapability = new Map<string, LedgerEntry[]>();
  for (const entry of ctx.manifest.getActions()) {
    if (ledgerActionIdsBeforeRun.has(entry.id)) {
      continue;
    }
    const bucket = newEntriesByCapability.get(entry.plugin);
    if (bucket) {
      bucket.push(entry);
    } else {
      newEntriesByCapability.set(entry.plugin, [entry]);
    }
  }

  const manualCleanup: string[] = [];
  const reverted: string[] = [];
  for (const capabilityId of [...appliedCapabilityOrder].reverse()) {
    const plugin = pluginById.get(capabilityId);
    const newEntries = newEntriesByCapability.get(capabilityId) ?? [];
    if (!plugin?.revert || newEntries.length === 0) {
      continue;
    }
    try {
      await plugin.revert(ctx, newEntries);
      reverted.push(capabilityId);
    } catch (revertError) {
      manualCleanup.push(`${capabilityId}: ${errorMessage(revertError)}`);
    }
  }

  return { reverted, manualCleanup };
}

function fileTargetingOperations(
  operations: ProposedOperation[],
): ProposedOperation[] {
  return operations.filter((operation) =>
    FILE_TARGETING_ACTIONS.has(operation.action),
  );
}

async function enforceWorkspaceIsolation(
  ctx: Context,
  input: ApplyPlanInput,
): Promise<void> {
  if (input.isolationStatus === "ignored") {
    return;
  }
  if (input.allowUnignoredState) {
    ctx.ui.info(
      "Writing .agemon/ state without a .gitignore entry (--allow-unignored-state).",
    );
    return;
  }
  if (input.workspaceIsolationApproved === true) {
    await writeAgemonGitignoreEntry(ctx.cwd);
    return;
  }
  throw new Error(
    "Refusing to write .agemon/ state: /.agemon/ is not git-ignored. Re-run " +
      "interactively (or with --yes) so agemon can add it, or pass " +
      "--allow-unignored-state to override.",
  );
}

async function assertPlanIsFresh(
  ctx: Context,
  planId: string,
  operations: ProposedOperation[],
): Promise<void> {
  for (const operation of fileTargetingOperations(operations)) {
    const currentContents = await readFileIfExists(
      join(ctx.cwd, operation.targetPath),
    );
    const actualFingerprint =
      currentContents === null ? null : fingerprintContent(currentContents);
    if (actualFingerprint !== operation.expectedFingerprint) {
      throw new Error(
        `Plan ${planId} is stale: ${operation.targetPath} changed since it was planned. Re-run 'agemon plan'.`,
      );
    }
  }
}

async function captureRollbackSnapshots(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<FileRollbackSnapshot[]> {
  const snapshots: FileRollbackSnapshot[] = [];
  for (const operation of fileTargetingOperations(operations)) {
    const previousContents = await readFileIfExists(
      join(ctx.cwd, operation.targetPath),
    );
    snapshots.push({ targetPath: operation.targetPath, previousContents });
    if (previousContents !== null) {
      await writeImmutableBackup(
        ctx.cwd,
        operation.resourceId,
        previousContents,
      );
    }
  }
  return snapshots;
}

async function restoreRollbackSnapshots(
  ctx: Context,
  snapshots: FileRollbackSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const absolutePath = join(ctx.cwd, snapshot.targetPath);
    if (snapshot.previousContents === null) {
      await rm(absolutePath, { force: true });
    } else {
      await writeFile(absolutePath, snapshot.previousContents, "utf8");
    }
  }
}

function groupApprovedByCapability(
  plan: Plan,
  approved: ProposedOperation[],
): Map<string, ProposedOperation[]> {
  const approvedIds = new Set(approved.map((operation) => operation.id));
  const grouped = new Map<string, ProposedOperation[]>();
  for (const operation of plan.operations) {
    if (!approvedIds.has(operation.id)) {
      continue;
    }
    const bucket = grouped.get(operation.capabilityId);
    if (bucket) {
      bucket.push(operation);
    } else {
      grouped.set(operation.capabilityId, [operation]);
    }
  }
  return grouped;
}

async function runCapabilityWork(
  ctx: Context,
  plugin: AgemonPlugin,
  operations: ProposedOperation[],
  staged: StagedFile[] | undefined,
): Promise<void> {
  if (plugin.apply) {
    await plugin.apply(ctx, operations, staged);
  } else {
    const presence = await plugin.detect(ctx);
    if (presence.present) {
      ctx.ui.info(`${plugin.id} already present — nothing to install`);
    } else {
      await plugin.install(ctx);
    }
  }

  const verification = await plugin.verify(ctx);
  if (!verification.ok) {
    throw new Error(
      verification.detail ??
        `Verification failed for '${plugin.id}' after apply.`,
    );
  }

  for (const operation of operations) {
    await ctx.manifest.updateResourceEntry(operation.resourceId, {
      validation: { ok: true },
    });
  }
}

export async function applyPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  input: ApplyPlanInput,
): Promise<ApplyPlanResult> {
  const pluginById = new Map(
    allPlugins.map((plugin) => [plugin.id, plugin] as const),
  );
  const approvedByCapability = groupApprovedByCapability(
    input.plan,
    input.approved,
  );

  ctx.manifest.setRecordingAgemonVersion(input.plan.agemonVersion);

  await enforceWorkspaceIsolation(ctx, input);
  await writePlan(ctx.cwd, input.plan);
  await assertPlanIsFresh(ctx, input.plan.id, input.approved);

  const stagedByCapability = await stageApprovedFiles(
    ctx,
    pluginById,
    input.plan.id,
    approvedByCapability,
  );

  const rollbackSnapshots = await captureRollbackSnapshots(ctx, input.approved);
  const ledgerActionIdsBeforeRun = new Set(
    ctx.manifest.getActions().map((action) => action.id),
  );

  const applied: ProposedOperation[] = [];
  const appliedCapabilityOrder: string[] = [];
  try {
    for (const [capabilityId, operations] of approvedByCapability) {
      const plugin = pluginById.get(capabilityId);
      if (!plugin) {
        throw new Error(
          `Plan references capability '${capabilityId}', which is not registered.`,
        );
      }
      await runCapabilityWork(
        ctx,
        plugin,
        operations,
        stagedByCapability.get(capabilityId),
      );
      appliedCapabilityOrder.push(capabilityId);
      applied.push(...operations);
    }
  } catch (error) {
    await restoreRollbackSnapshots(ctx, rollbackSnapshots);
    const { reverted, manualCleanup } = await revertCommittedCapabilities(
      ctx,
      pluginById,
      appliedCapabilityOrder,
      ledgerActionIdsBeforeRun,
    );
    await ctx.manifest.removeActionsAddedSince(ledgerActionIdsBeforeRun);
    ctx.ui.fail(
      `apply rolled back — repo left as it started (${errorMessage(error)})`,
    );
    for (const detail of manualCleanup) {
      ctx.ui.fail(`manual cleanup needed: ${detail}`);
    }
    throw new ApplyRollbackError({
      message: errorMessage(error),
      restored: rollbackSnapshots.map((snapshot) =>
        snapshot.previousContents === null
          ? `removed ${snapshot.targetPath}`
          : `restored ${snapshot.targetPath}`,
      ),
      reverted,
      manualCleanup,
    });
  }

  return { applied };
}
