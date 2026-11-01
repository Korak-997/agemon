import { rm } from "node:fs/promises";
import { relative } from "node:path";
import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import type { ApplyJournal, JournalSnapshot } from "./apply-journal.js";
import type { Context } from "./context.js";
import { errorMessage } from "./error-message.js";
import {
  RefusedFileError,
  readRegularFileIfExists,
  saveVerifiedCopyBeside,
  writeFileAtomic,
} from "./files.js";
import { fingerprintContent } from "./fingerprint.js";
import { readPlan } from "./plan-store.js";
import { resolveInsideRepo } from "./repo-paths.js";
import type { LedgerEntry } from "./state-manifest.js";
import { printable } from "./untrusted-text.js";

export type SnapshotState = "unchanged" | "restore" | "changed-since";

export interface ClassifiedSnapshot {
  snapshot: JournalSnapshot;
  state: SnapshotState;
}

export interface RollbackOutcome {
  restored: string[];
  reverted: string[];
  kept: string[];
  manualCleanup: string[];
  unsavedCount: number;
}

interface NewEntries {
  toRevertByCapability: Map<string, LedgerEntry[]>;
  kept: LedgerEntry[];
}

async function classifySnapshot(
  ctx: Context,
  snapshot: JournalSnapshot,
): Promise<SnapshotState> {
  let currentContents: string | null;
  try {
    currentContents = await readRegularFileIfExists(
      await resolveInsideRepo(ctx.cwd, snapshot.targetPath),
    );
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return "changed-since";
    }
    throw error;
  }
  if (currentContents === snapshot.previousContents) {
    return "unchanged";
  }
  if (
    currentContents === null ||
    fingerprintContent(currentContents) === snapshot.stagedFingerprint
  ) {
    return "restore";
  }
  return "changed-since";
}

export async function classifySnapshots(
  ctx: Context,
  journal: ApplyJournal,
): Promise<ClassifiedSnapshot[]> {
  const classified: ClassifiedSnapshot[] = [];
  for (const snapshot of [...journal.snapshots].reverse()) {
    classified.push({ snapshot, state: await classifySnapshot(ctx, snapshot) });
  }
  return classified;
}

async function restoreSnapshot(
  ctx: Context,
  snapshot: JournalSnapshot,
): Promise<string> {
  const absolutePath = await resolveInsideRepo(ctx.cwd, snapshot.targetPath);
  if (snapshot.previousContents === null) {
    await rm(absolutePath, { force: true });
    return `removed ${snapshot.targetPath}`;
  }
  await writeFileAtomic(absolutePath, snapshot.previousContents);
  return `restored ${snapshot.targetPath}`;
}

async function preservePreApplyContents(
  ctx: Context,
  snapshot: JournalSnapshot,
  problem: string,
  outcome: RollbackOutcome,
): Promise<void> {
  const target = printable(snapshot.targetPath);
  if (snapshot.previousContents === null) {
    outcome.manualCleanup.push(`${target}: ${problem}`);
    return;
  }
  try {
    const savedPath = await saveVerifiedCopyBeside(
      await resolveInsideRepo(ctx.cwd, snapshot.targetPath),
      snapshot.previousContents,
    );
    outcome.manualCleanup.push(
      `${target}: ${problem}; its pre-apply contents are saved as ${printable(relative(ctx.cwd, savedPath))}`,
    );
  } catch (saveError) {
    outcome.unsavedCount += 1;
    outcome.manualCleanup.push(
      `${target}: ${problem}; could not save its pre-apply contents (${errorMessage(saveError)})`,
    );
  }
}

function describeFailedRestoreForRetry(
  snapshot: JournalSnapshot,
  error: unknown,
): string {
  const failure =
    snapshot.previousContents === null
      ? `could not remove it (${errorMessage(error)})`
      : `could not restore its pre-apply contents (${errorMessage(error)})`;
  return `${printable(snapshot.targetPath)}: ${failure}; run 'agemon recover' to retry.`;
}

async function rollBackSnapshots(
  ctx: Context,
  classified: ClassifiedSnapshot[],
  options: { saveFailedRestores: boolean },
  outcome: RollbackOutcome,
): Promise<Set<string>> {
  const unrestoredTargets = new Set<string>();
  for (const { snapshot, state } of classified) {
    if (state === "unchanged") {
      continue;
    }
    if (state === "changed-since") {
      unrestoredTargets.add(snapshot.targetPath);
      await preservePreApplyContents(
        ctx,
        snapshot,
        "changed since the apply started — kept as is",
        outcome,
      );
      continue;
    }
    try {
      outcome.restored.push(await restoreSnapshot(ctx, snapshot));
    } catch (restoreError) {
      unrestoredTargets.add(snapshot.targetPath);
      if (options.saveFailedRestores) {
        await preservePreApplyContents(
          ctx,
          snapshot,
          `could not restore it (${errorMessage(restoreError)})`,
          outcome,
        );
      } else {
        outcome.manualCleanup.push(
          describeFailedRestoreForRetry(snapshot, restoreError),
        );
      }
    }
  }
  return unrestoredTargets;
}

export function partitionNewEntries(
  ledger: LedgerEntry[],
  journal: ApplyJournal,
  pluginById: Map<string, AgemonPlugin>,
  unrestoredTargets: ReadonlySet<string>,
): NewEntries {
  const entryIdsBefore = new Set(journal.ledgerBefore.map((entry) => entry.id));
  const newEntries: NewEntries = {
    toRevertByCapability: new Map(),
    kept: [],
  };
  for (const capabilityId of [...journal.capabilityOrder].reverse()) {
    const entriesOfCapability = ledger.filter(
      (entry) =>
        entry.plugin === capabilityId &&
        entry.planId === journal.planId &&
        !entryIdsBefore.has(entry.id),
    );
    const toRevert = entriesOfCapability.filter(
      (entry) => !unrestoredTargets.has(entry.target),
    );
    newEntries.kept.push(
      ...entriesOfCapability.filter((entry) =>
        unrestoredTargets.has(entry.target),
      ),
    );
    if (toRevert.length > 0 && pluginById.get(capabilityId)?.revert) {
      newEntries.toRevertByCapability.set(capabilityId, toRevert);
    }
  }
  return newEntries;
}

export async function rollBackApply(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  journal: ApplyJournal,
  options: { saveFailedRestores: boolean },
): Promise<RollbackOutcome> {
  const outcome: RollbackOutcome = {
    restored: [],
    reverted: [],
    kept: [],
    manualCleanup: [],
    unsavedCount: 0,
  };
  const unrestoredTargets = await rollBackSnapshots(
    ctx,
    await classifySnapshots(ctx, journal),
    options,
    outcome,
  );

  const { toRevertByCapability, kept } = partitionNewEntries(
    ctx.manifest.getActions(),
    journal,
    pluginById,
    unrestoredTargets,
  );
  for (const [capabilityId, entries] of toRevertByCapability) {
    try {
      await pluginById.get(capabilityId)?.revert?.(ctx, entries);
      outcome.reverted.push(capabilityId);
    } catch (revertError) {
      outcome.manualCleanup.push(
        `${capabilityId}: ${printable(errorMessage(revertError))}`,
      );
      kept.push(...entries);
    }
  }

  try {
    await ctx.manifest.restoreActions([...journal.ledgerBefore, ...kept]);
  } catch (ledgerError) {
    outcome.manualCleanup.push(`ledger: ${errorMessage(ledgerError)}`);
  }
  outcome.kept = await describeKeptChanges(ctx, pluginById, journal);
  return outcome;
}

async function describeKeptChanges(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  journal: ApplyJournal,
): Promise<string[]> {
  return (await describeKeptSubjects(ctx, pluginById, journal)).map(
    (subject) => `Kept ${subject}`,
  );
}

export async function describeKeptSubjects(
  ctx: Context,
  pluginById: Map<string, AgemonPlugin>,
  journal: ApplyJournal,
): Promise<string[]> {
  let operations: ProposedOperation[];
  try {
    operations = (await readPlan(ctx.cwd, journal.planId)).operations;
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const capabilityId of journal.capabilityOrder) {
    const describeKept =
      pluginById.get(capabilityId)?.describeKeptAfterRollback;
    if (describeKept === undefined) {
      continue;
    }
    try {
      lines.push(
        ...(await describeKept(
          ctx,
          operations.filter(
            (operation) => operation.capabilityId === capabilityId,
          ),
        )),
      );
    } catch {
      // A kept-changes note is informational; the rollback itself already finished.
    }
  }
  return lines;
}
