import { join } from "node:path";
import type { IsolationStatus } from "../inspect/discover.js";
import type {
  AgemonPlugin,
  ProposedOperation,
  StagedFile,
} from "../plugins/types.js";
import { capabilityLabel } from "../ui/labels.js";
import { SILENT_PROGRESS } from "../ui/progress.js";
import {
  type ApplyJournal,
  deleteJournal,
  type JournalSnapshot,
  writeJournal,
} from "./apply-journal.js";
import type { Context } from "./context.js";
import { errorMessage } from "./error-message.js";
import { readRegularFileIfExists, writeFileAtomic } from "./files.js";
import { fingerprintContent, sha256Hex } from "./fingerprint.js";
import { writeAgemonGitignoreEntry } from "./gitignore.js";
import {
  type ExitProcess,
  type InterruptionWatch,
  ignoringTerminalErrors,
  watchForInterruption,
} from "./interruption.js";
import { PLAN_SEGMENTS, type Plan, writePlan } from "./plan-store.js";
import { resolveInsideRepo, resolveStateDirectory } from "./repo-paths.js";
import { rollBackApply } from "./rollback.js";

export const FILE_TARGETING_ACTIONS: ReadonlySet<ProposedOperation["action"]> =
  new Set(["create", "replace", "merge-block", "merge-key", "adopt"]);

const STAGED_FILE_NAME_LENGTH = 16;
const STAGED_MANIFEST_FILE = "manifest.json";
const INTERRUPTED_MESSAGE =
  "Interrupted — rolling back after the current step (press Ctrl-C again to stop now, then run 'agemon recover').";

export interface ApplyPlanInput {
  plan: Plan;
  approved: ProposedOperation[];
  workspaceIsolationApproved: boolean | null;
  isolationStatus: IsolationStatus;
  allowUnignoredState: boolean;
  exitProcess?: ExitProcess;
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

  constructor(rollback: RollbackDetail, cause: unknown) {
    super(rollback.message, { cause });
    this.name = "ApplyRollbackError";
    this.rollback = rollback;
  }
}

function stagedFileName(targetPath: string): string {
  return sha256Hex(targetPath).slice(0, STAGED_FILE_NAME_LENGTH);
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
  const stagedTargetsByFileName: Record<string, string> = {};
  let stagedRoot: string | null = null;

  for (const [capabilityId, operations] of approvedByCapability) {
    const plugin = pluginById.get(capabilityId);
    if (!plugin?.materialize) {
      continue;
    }

    const stagedFiles = await plugin.materialize(ctx, operations);
    if (stagedFiles.length === 0) {
      continue;
    }

    stagedRoot ??= await resolveStateDirectory(
      ctx.cwd,
      [...PLAN_SEGMENTS, planId, "staged"],
      { create: true },
    );

    for (const staged of stagedFiles) {
      const fileName = stagedFileName(staged.targetPath);
      stagedTargetsByFileName[fileName] = staged.targetPath;
      await writeFileAtomic(join(stagedRoot, fileName), staged.contents);
      const problem = validateStagedFile(staged);
      if (problem !== null) {
        throw new Error(
          `Refusing to apply plan ${planId}: staged file failed validation — ${problem}`,
        );
      }
    }

    stagedByCapability.set(capabilityId, stagedFiles);
  }

  if (stagedRoot !== null) {
    await writeFileAtomic(
      join(stagedRoot, STAGED_MANIFEST_FILE),
      `${JSON.stringify(stagedTargetsByFileName, null, 2)}\n`,
    );
  }
  return stagedByCapability;
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
    const currentContents = await readRegularFileIfExists(
      await resolveInsideRepo(ctx.cwd, operation.targetPath),
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

function stagedFingerprintsByTarget(
  stagedByCapability: Map<string, StagedFile[]>,
): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const stagedFiles of stagedByCapability.values()) {
    for (const staged of stagedFiles) {
      fingerprints.set(staged.targetPath, fingerprintContent(staged.contents));
    }
  }
  return fingerprints;
}

async function captureRollbackSnapshots(
  ctx: Context,
  operations: ProposedOperation[],
  stagedByCapability: Map<string, StagedFile[]>,
): Promise<JournalSnapshot[]> {
  const stagedFingerprints = stagedFingerprintsByTarget(stagedByCapability);
  const snapshots: JournalSnapshot[] = [];
  for (const operation of fileTargetingOperations(operations)) {
    const previousContents = await readRegularFileIfExists(
      await resolveInsideRepo(ctx.cwd, operation.targetPath),
    );
    snapshots.push({
      targetPath: operation.targetPath,
      previousContents,
      stagedFingerprint: stagedFingerprints.get(operation.targetPath) ?? null,
    });
  }
  return snapshots;
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

async function rollBackInProcess(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  journalPath: string,
  journal: ApplyJournal,
  cause: unknown,
): Promise<never> {
  const outcome = await rollBackApply(ctx, pluginById, journal, {
    saveFailedRestores: false,
  });
  const manualCleanup = [...outcome.manualCleanup];
  if (manualCleanup.length === 0) {
    try {
      await deleteJournal(journalPath);
    } catch (journalError) {
      manualCleanup.push(`journal: ${errorMessage(journalError)}`);
    }
  }

  ignoringTerminalErrors(() => {
    ctx.ui.fail(
      manualCleanup.length === 0
        ? `apply rolled back — repo left as it started (${errorMessage(cause)})`
        : `apply partly rolled back — the journal is kept; fix the items below, then run 'agemon recover' (${errorMessage(cause)})`,
    );
    for (const detail of manualCleanup) {
      ctx.ui.fail(`manual cleanup needed: ${detail}`);
    }
  });
  throw new ApplyRollbackError(
    {
      message: errorMessage(cause),
      restored: outcome.restored,
      reverted: outcome.reverted,
      manualCleanup,
    },
    cause,
  );
}

async function deleteJournalAfterSuccess(
  ctx: Context,
  journalPath: string,
): Promise<void> {
  try {
    await deleteJournal(journalPath);
  } catch (journalError) {
    ignoringTerminalErrors(() =>
      ctx.ui.fail(
        `Applied, but could not delete the rollback journal ${journalPath} (${errorMessage(journalError)}). Delete it by hand; do not run 'agemon recover', which would undo this apply.`,
      ),
    );
  }
}

async function runJournalledCapabilities(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  approvedByCapability: Map<string, ProposedOperation[]>,
  stagedByCapability: Map<string, StagedFile[]>,
  interruption: InterruptionWatch,
  { path: journalPath, journal }: { path: string; journal: ApplyJournal },
): Promise<ProposedOperation[]> {
  const progress = ctx.progress ?? SILENT_PROGRESS;
  const capabilityCount = approvedByCapability.size;
  const applied: ProposedOperation[] = [];
  progress.start("Applying capabilities", capabilityCount);
  try {
    for (const [capabilityId, operations] of approvedByCapability) {
      interruption.throwIfInterrupted();
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
      progress.advance(`Applied ${capabilityLabel(capabilityId)}`);
      applied.push(...operations);
    }
    interruption.throwIfInterrupted();
    progress.stop(
      `Applied ${capabilityCount} ${
        capabilityCount === 1 ? "capability" : "capabilities"
      }`,
    );
  } catch (error) {
    progress.stop();
    return rollBackInProcess(
      ctx,
      pluginById,
      journalPath,
      journal,
      interruption.causeOf(error),
    );
  }

  await deleteJournalAfterSuccess(ctx, journalPath);
  return applied;
}

async function applyApprovedOperations(
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

  await assertPlanIsFresh(ctx, input.plan.id, input.approved);
  await enforceWorkspaceIsolation(ctx, input);
  await writePlan(ctx.cwd, input.plan);

  const stagedByCapability = await stageApprovedFiles(
    ctx,
    pluginById,
    input.plan.id,
    approvedByCapability,
  );
  const snapshots = await captureRollbackSnapshots(
    ctx,
    input.approved,
    stagedByCapability,
  );

  const interruption = watchForInterruption(() => {
    ctx.progress?.stop();
    ctx.ui.fail(INTERRUPTED_MESSAGE);
  }, input.exitProcess ?? process.exit);
  try {
    const storedJournal = await writeJournal(ctx.cwd, {
      planId: input.plan.id,
      startedAt: new Date().toISOString(),
      capabilityOrder: [...approvedByCapability.keys()],
      ledgerBefore: structuredClone(ctx.manifest.getActions()),
      snapshots,
    });
    const applied = await runJournalledCapabilities(
      ctx,
      pluginById,
      approvedByCapability,
      stagedByCapability,
      interruption,
      storedJournal,
    );
    return { applied };
  } finally {
    interruption.dispose();
  }
}

export async function applyPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  input: ApplyPlanInput,
): Promise<ApplyPlanResult> {
  ctx.manifest.setRecordingAgemonVersion(input.plan.agemonVersion);
  ctx.manifest.setRecordingPlanId(input.plan.id);
  try {
    return await applyApprovedOperations(ctx, allPlugins, input);
  } finally {
    ctx.manifest.setRecordingAgemonVersion(null);
    ctx.manifest.setRecordingPlanId(null);
  }
}
