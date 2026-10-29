import { rm } from "node:fs/promises";
import { relative } from "node:path";
import { type FoundBackup, readFirstExistingBackup } from "./backups.js";
import type { Context } from "./context.js";
import {
  readRegularFileIfExists,
  saveVerifiedCopyBeside,
  writeFileAtomic,
} from "./files.js";
import { fingerprintContent } from "./fingerprint.js";
import { resolveInsideRepo } from "./repo-paths.js";
import type { LedgerEntry } from "./state-manifest.js";

interface ManagedFileRevertOptions {
  backupCandidates: string[];
  salvage?: (currentContents: string) => string | null;
}

async function findPreferredBackup(
  ctx: Context,
  action: LedgerEntry,
  backupCandidates: string[],
): Promise<FoundBackup | null> {
  let firstExisting: FoundBackup | null = null;
  for (const candidatePath of backupCandidates) {
    const candidate = await readFirstExistingBackup(ctx.cwd, [candidatePath]);
    if (candidate === null) {
      continue;
    }
    if (fingerprintContent(candidate.contents) === action.fingerprintBefore) {
      return candidate;
    }
    firstExisting ??= candidate;
  }
  return firstExisting;
}

async function removeRedundantBackups(
  ctx: Context,
  action: LedgerEntry,
  backupCandidates: string[],
  resolvedBackup: FoundBackup | null,
  contentsKeptElsewhere: string | null,
): Promise<void> {
  for (const candidatePath of backupCandidates) {
    const candidate = await readFirstExistingBackup(ctx.cwd, [candidatePath]);
    if (candidate === null) {
      continue;
    }
    const isVerifiedResolvedBackup =
      candidate.path === resolvedBackup?.path &&
      fingerprintContent(candidate.contents) === action.fingerprintBefore;
    if (
      isVerifiedResolvedBackup ||
      candidate.contents === contentsKeptElsewhere
    ) {
      await rm(candidate.path, { force: true });
    }
  }
}

async function preserveChangedFile(
  ctx: Context,
  action: LedgerEntry,
  backupCandidates: string[],
  targetIsMissing: boolean,
  backup: FoundBackup | null,
): Promise<void> {
  const what = targetIsMissing
    ? `${action.target} was removed since agemon wrote it`
    : `${action.target} changed since agemon wrote it — kept as is`;
  if (backup === null) {
    ctx.ui.info(`manual cleanup needed: ${what}`);
    return;
  }
  const savedPath = await saveVerifiedCopyBeside(
    await resolveInsideRepo(ctx.cwd, action.target),
    backup.contents,
  );
  await removeRedundantBackups(
    ctx,
    action,
    backupCandidates,
    backup,
    backup.contents,
  );
  ctx.ui.info(
    `manual cleanup needed: ${what}; earlier contents saved as ${relative(ctx.cwd, savedPath)}`,
  );
}

export async function revertManagedFile(
  ctx: Context,
  action: LedgerEntry,
  { backupCandidates, salvage }: ManagedFileRevertOptions,
): Promise<void> {
  const targetPath = await resolveInsideRepo(ctx.cwd, action.target);
  const currentContents = await readRegularFileIfExists(targetPath);
  const currentFingerprint =
    currentContents === null ? null : fingerprintContent(currentContents);
  const backup = await findPreferredBackup(ctx, action, backupCandidates);
  const backupIsVerified =
    backup !== null &&
    fingerprintContent(backup.contents) === action.fingerprintBefore;

  if (
    currentFingerprint !== null &&
    currentFingerprint === action.fingerprintBefore
  ) {
    await removeRedundantBackups(
      ctx,
      action,
      backupCandidates,
      backup,
      currentContents,
    );
    return;
  }

  const untouchedSinceAgemonWrote =
    currentContents === null || currentFingerprint === action.fingerprintAfter;
  if (untouchedSinceAgemonWrote && !action.preExisting) {
    await rm(targetPath, { force: true });
    return;
  }
  if (untouchedSinceAgemonWrote && backupIsVerified) {
    await writeFileAtomic(targetPath, backup.contents);
    await removeRedundantBackups(
      ctx,
      action,
      backupCandidates,
      backup,
      backup.contents,
    );
    return;
  }

  const salvaged =
    currentContents === null || salvage === undefined
      ? null
      : salvage(currentContents);
  if (salvaged !== null) {
    if (!action.preExisting && salvaged.trim().length === 0) {
      await rm(targetPath, { force: true });
    } else {
      await writeFileAtomic(targetPath, salvaged);
    }
    await removeRedundantBackups(ctx, action, backupCandidates, backup, null);
    return;
  }

  await preserveChangedFile(
    ctx,
    action,
    backupCandidates,
    currentContents === null,
    backup,
  );
}
