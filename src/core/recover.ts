import type { AgemonPlugin } from "../plugins/types.js";
import {
  type ApplyJournal,
  deleteJournal,
  invalidJournalError,
  readJournals,
} from "./apply-journal.js";
import type { Context } from "./context.js";
import {
  type ClassifiedSnapshot,
  classifySnapshots,
  partitionNewEntries,
  rollBackApply,
} from "./rollback.js";
import { printable } from "./untrusted-text.js";

export const RECOVER_LIMIT_NOTE =
  "Work a capability had started but not yet recorded when the apply was interrupted is not undone. Check 'agemon status' for tools the interrupted apply may have installed.";
const TEMPORARY_FILES_NOTE =
  "Interrupted writes may leave '<file>.tmp-<pid>-<id>' files next to the targets; delete them if present.";

function describeSnapshotStep({ snapshot, state }: ClassifiedSnapshot): string {
  const target = printable(snapshot.targetPath);
  if (state === "restore") {
    return snapshot.previousContents === null
      ? `remove ${target}`
      : `restore ${target}`;
  }
  const keep = `keep ${target} and agemon's ledger entry for it (changed since the interrupted apply)`;
  return snapshot.previousContents === null
    ? keep
    : `${keep}; save its pre-apply contents beside it (${target}.agemon-original, or a timestamped name if that exists)`;
}

function assertCapabilitiesAreRegistered(
  journalPath: string,
  journal: ApplyJournal,
  pluginById: Map<string, AgemonPlugin>,
): void {
  const unknownCapabilityIds = journal.capabilityOrder.filter(
    (capabilityId) => !pluginById.has(capabilityId),
  );
  if (unknownCapabilityIds.length > 0) {
    throw invalidJournalError(
      journalPath,
      `it names unknown capabilities: ${unknownCapabilityIds.map(printable).join(", ")}`,
    );
  }
}

function buildRecoverySteps(
  ctx: Context,
  journal: ApplyJournal,
  pluginById: Map<string, AgemonPlugin>,
  classified: ClassifiedSnapshot[],
): string[] {
  const steps = classified
    .filter(({ state }) => state !== "unchanged")
    .map(describeSnapshotStep);
  const changedTargets = new Set(
    classified
      .filter(({ state }) => state === "changed-since")
      .map(({ snapshot }) => snapshot.targetPath),
  );
  const { toRevertByCapability, kept } = partitionNewEntries(
    ctx.manifest.getActions(),
    journal,
    pluginById,
    changedTargets,
  );
  for (const [capabilityId, entries] of toRevertByCapability) {
    steps.push(
      `revert ${capabilityId}: ${entries.map((entry) => printable(entry.target)).join(", ")}`,
    );
  }
  const ledgerAfterRecovery = [...journal.ledgerBefore, ...kept];
  if (
    JSON.stringify(ctx.manifest.getActions()) !==
    JSON.stringify(ledgerAfterRecovery)
  ) {
    steps.push(
      journal.ledgerBefore.length === 0
        ? "ledger: remove the entries the apply added"
        : `ledger: reset to its ${journal.ledgerBefore.length} pre-apply entries`,
    );
  }
  return steps;
}

async function selectSingleJournal(
  ctx: Context,
): Promise<{ path: string; journal: ApplyJournal } | null> {
  const journals = await readJournals(ctx.cwd);
  if (journals.length > 1) {
    throw new Error(
      `Found ${journals.length} interrupted-apply journals for this repository, so agemon cannot tell which to restore first:\n${journals
        .map((stored) => `  ${stored.path}`)
        .join(
          "\n",
        )}\nMove all but one aside, run 'agemon recover', then put the next one back.`,
    );
  }
  return journals[0] ?? null;
}

export async function recoverInterruptedApply(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: { dryRun: boolean },
): Promise<void> {
  const stored = await selectSingleJournal(ctx);
  if (stored === null) {
    ctx.log.log("Nothing to recover.");
    return;
  }
  const { path: journalPath, journal } = stored;
  const pluginById = new Map(
    allPlugins.map((plugin) => [plugin.id, plugin] as const),
  );
  assertCapabilitiesAreRegistered(journalPath, journal, pluginById);

  const classified = await classifySnapshots(ctx, journal);
  const steps = buildRecoverySteps(ctx, journal, pluginById, classified);
  if (steps.length === 0) {
    if (!options.dryRun) {
      await deleteJournal(journalPath);
    }
    ctx.log.log(
      `Nothing to recover: the files and the ledger already match their state before plan ${journal.planId}.\n${RECOVER_LIMIT_NOTE}`,
    );
    return;
  }

  ctx.log.log(
    `The apply of plan ${journal.planId} (started ${journal.startedAt}) was interrupted. Recovering it will:\n${steps
      .map((step) => `  - ${step}`)
      .join("\n")}\n${RECOVER_LIMIT_NOTE}`,
  );
  if (options.dryRun) {
    return;
  }
  if (!ctx.yes && !ctx.interactive) {
    throw new Error("Nothing restored: re-run interactively or with --yes.");
  }
  if (!(await ctx.confirm("Restore these changes?"))) {
    throw new Error(
      "Nothing restored. agemon stays blocked in this repository until 'agemon recover' completes.",
    );
  }

  const outcome = await rollBackApply(ctx, pluginById, journal, {
    saveFailedRestores: true,
  });
  for (const line of outcome.restored) {
    ctx.ui.succeed(line);
  }
  for (const capabilityId of outcome.reverted) {
    ctx.ui.succeed(`reverted ${capabilityId}`);
  }
  for (const detail of outcome.manualCleanup) {
    ctx.ui.fail(`manual cleanup needed: ${detail}`);
  }
  ctx.log.log(TEMPORARY_FILES_NOTE);

  if (outcome.unsavedCount > 0) {
    throw new Error(
      `Kept the journal ${journalPath}, because it holds the only copy of ${outcome.unsavedCount} file(s) agemon could not restore or save. Fix the problem above and re-run 'agemon recover'. Deleting the journal unblocks agemon but discards those contents.`,
    );
  }
  await deleteJournal(journalPath);
  if (outcome.manualCleanup.length > 0) {
    throw new Error(
      "Recovery finished, but some changes need manual cleanup (listed above).",
    );
  }
  ctx.ui.succeed(`Recovered the interrupted apply of plan ${journal.planId}.`);
}
