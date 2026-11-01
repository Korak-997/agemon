import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, realpath, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import {
  FileTooLargeError,
  MAX_READ_FILE_LABEL,
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "../../core/files.js";
import { resolveRepoDirectory } from "../../core/repo-paths.js";
import { printable } from "../../core/untrusted-text.js";
import { fingerprintInstalledSkill } from "./skill-tree.js";
import {
  CANONICAL_SKILLS_DIRECTORY,
  CLAUDE_SKILLS_DIRECTORY,
  SKILLS_LOCK_FILE,
} from "./skills-cli-targets.js";

const DIFFERS_FROM_INSTALLED =
  "it differs from every version agemon installed; delete it if you no longer need it.";
const CHANGED_DURING_REMOVAL = "it changed while agemon was removing it.";
const QUARANTINE_PREFIX = ".agemon-removing-";
const QUARANTINE_SUFFIX_BYTES = 8;
const SUPPORTED_LOCK_VERSION = 1;

export type SkillRemoval =
  | { kind: "removed" }
  | { kind: "gone" }
  | { kind: "kept" }
  | { kind: "failed"; detail: string };

type IsAgemonContent = (fingerprint: string) => boolean;

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function keep(ctx: Context, skillName: string, reason: string): SkillRemoval {
  ctx.ui.info(
    `${ctx.dryRun ? "Would keep" : "Keeping"} ${CLAUDE_SKILLS_DIRECTORY}/${printable(skillName)}: ${reason}`,
  );
  return { kind: "kept" };
}

function removed(ctx: Context, skillName: string): SkillRemoval {
  if (ctx.dryRun) {
    ctx.ui.info(`Would remove skill ${printable(skillName)}`);
  }
  return { kind: "removed" };
}

async function resolveSkillsDirectory(
  ctx: Context,
  relativeDirectory: string,
): Promise<string | null | "refused"> {
  try {
    return await resolveRepoDirectory(ctx.cwd, relativeDirectory);
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return "refused";
    }
    throw error;
  }
}

async function fingerprintIfReadable(
  directory: string,
): Promise<string | null> {
  try {
    return await fingerprintInstalledSkill(directory);
  } catch {
    return null;
  }
}

async function verifiedSkillsDirectory(ctx: Context): Promise<string | null> {
  const expected = join(await realpath(ctx.cwd), CLAUDE_SKILLS_DIRECTORY);
  const resolved = await resolveSkillsDirectory(ctx, CLAUDE_SKILLS_DIRECTORY);
  if (resolved === null || resolved === "refused") {
    return null;
  }
  return (await realpath(resolved)) === expected ? expected : null;
}

function isSameEntry(expected: Stats, actual: Stats | null): boolean {
  return (
    actual !== null &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

function quarantineName(skillName: string): string {
  return `${QUARANTINE_PREFIX}${skillName}-${randomBytes(QUARANTINE_SUFFIX_BYTES).toString("hex")}`;
}

async function unlinkSymlinkedCopy(
  ctx: Context,
  skillName: string,
  linkStats: Stats,
): Promise<SkillRemoval> {
  if (!ctx.dryRun) {
    const skillsDirectory = await verifiedSkillsDirectory(ctx);
    const linkPath =
      skillsDirectory === null ? null : join(skillsDirectory, skillName);
    if (
      linkPath === null ||
      !isSameEntry(linkStats, await lstatIfPresent(linkPath))
    ) {
      return keep(ctx, skillName, CHANGED_DURING_REMOVAL);
    }
    await unlink(linkPath);
  }
  ctx.ui.info(
    ctx.dryRun
      ? `Would remove the symlink ${CLAUDE_SKILLS_DIRECTORY}/${printable(skillName)}; its target is left alone.`
      : `Removed the symlink ${CLAUDE_SKILLS_DIRECTORY}/${printable(skillName)}; its target was left alone.`,
  );
  return { kind: "removed" };
}

async function removeDirectoryCopy(
  ctx: Context,
  skillName: string,
  copyPath: string,
  copyStats: Stats,
  isAgemonContent: IsAgemonContent,
): Promise<SkillRemoval> {
  const fingerprint = await fingerprintIfReadable(copyPath);
  if (fingerprint === null || !isAgemonContent(fingerprint)) {
    return keep(ctx, skillName, DIFFERS_FROM_INSTALLED);
  }
  if (ctx.dryRun) {
    return removed(ctx, skillName);
  }
  const skillsDirectory = await verifiedSkillsDirectory(ctx);
  if (skillsDirectory === null) {
    return keep(ctx, skillName, CHANGED_DURING_REMOVAL);
  }
  const verifiedCopyPath = join(skillsDirectory, skillName);
  const quarantine = quarantineName(skillName);
  const quarantinePath = join(skillsDirectory, quarantine);
  await rename(verifiedCopyPath, quarantinePath);
  const restoreCopy = () => rename(quarantinePath, verifiedCopyPath);
  try {
    const quarantinedStats = await lstatIfPresent(quarantinePath);
    const stillTheClassifiedCopy =
      quarantinedStats?.isDirectory() === true &&
      isSameEntry(copyStats, quarantinedStats) &&
      (await fingerprintIfReadable(quarantinePath)) === fingerprint;
    if (
      !stillTheClassifiedCopy ||
      (await verifiedSkillsDirectory(ctx)) !== skillsDirectory
    ) {
      await restoreCopy();
      return keep(ctx, skillName, CHANGED_DURING_REMOVAL);
    }
    await rm(quarantinePath, { recursive: true, force: true });
  } catch (error) {
    const restored = await restoreCopy().then(
      () => true,
      () => false,
    );
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      restored
        ? message
        : `${message}; agemon left the copy at ${CLAUDE_SKILLS_DIRECTORY}/${quarantine}`,
    );
  }
  return removed(ctx, skillName);
}

export async function removeAgemonSkillCopy(
  ctx: Context,
  skillName: string,
  isAgemonContent: IsAgemonContent,
): Promise<SkillRemoval> {
  try {
    const skillsDirectory = await resolveSkillsDirectory(
      ctx,
      CLAUDE_SKILLS_DIRECTORY,
    );
    if (skillsDirectory === "refused") {
      return keep(
        ctx,
        skillName,
        `${CLAUDE_SKILLS_DIRECTORY} is a symlink or not a real directory; agemon leaves it alone.`,
      );
    }
    if (skillsDirectory === null) {
      return { kind: "gone" };
    }
    const copyPath = join(skillsDirectory, skillName);
    const stats = await lstatIfPresent(copyPath);
    if (stats === null) {
      return { kind: "gone" };
    }
    if (stats.isSymbolicLink()) {
      return await unlinkSymlinkedCopy(ctx, skillName, stats);
    }
    if (!stats.isDirectory()) {
      return keep(
        ctx,
        skillName,
        "it is not a directory; agemon leaves it alone.",
      );
    }
    return await removeDirectoryCopy(
      ctx,
      skillName,
      copyPath,
      stats,
      isAgemonContent,
    );
  } catch (error) {
    return {
      kind: "failed",
      detail: `${CLAUDE_SKILLS_DIRECTORY}/${printable(skillName)}: ${printable(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

export async function reportLeftCanonicalCopy(
  ctx: Context,
  skillName: string,
  isShippedContent: IsAgemonContent,
): Promise<void> {
  try {
    const canonicalDirectory = await resolveSkillsDirectory(
      ctx,
      CANONICAL_SKILLS_DIRECTORY,
    );
    if (canonicalDirectory === null || canonicalDirectory === "refused") {
      return;
    }
    const copyPath = join(canonicalDirectory, skillName);
    if (!(await lstatIfPresent(copyPath))?.isDirectory()) {
      return;
    }
    const fingerprint = await fingerprintIfReadable(copyPath);
    if (fingerprint !== null && isShippedContent(fingerprint)) {
      ctx.ui.info(
        `Left ${CANONICAL_SKILLS_DIRECTORY}/${printable(skillName)}: agemon's skills CLI no longer writes it; remove it if you no longer need it.`,
      );
    }
  } catch {
    // The note is informational; a .agents copy agemon can't read is simply not mentioned.
  }
}

interface SkillsLock {
  version: number;
  skills: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseSkillsLock(contents: string): SkillsLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    !isPlainObject(parsed) ||
    typeof parsed.version !== "number" ||
    parsed.version !== SUPPORTED_LOCK_VERSION ||
    !isPlainObject(parsed.skills)
  ) {
    return null;
  }
  return parsed as unknown as SkillsLock;
}

export async function removeSkillsFromLock(
  ctx: Context,
  removedNames: string[],
  agemonOwnsLock: boolean,
): Promise<void> {
  if (removedNames.length === 0 && !agemonOwnsLock) {
    return;
  }
  const lockPath = join(ctx.cwd, SKILLS_LOCK_FILE);
  const stats = await lstatIfPresent(lockPath);
  if (stats === null) {
    return;
  }
  if (!stats.isFile()) {
    ctx.ui.info(`Keeping ${SKILLS_LOCK_FILE}: it is not a regular file.`);
    return;
  }
  let contents: string | null;
  try {
    contents = await readRegularFileIfExists(lockPath);
  } catch (error) {
    if (!(error instanceof RefusedFileError)) {
      throw error;
    }
    ctx.ui.info(
      error instanceof FileTooLargeError
        ? `Keeping ${SKILLS_LOCK_FILE}: it is too large for agemon to read (over ${MAX_READ_FILE_LABEL}).`
        : `Keeping ${SKILLS_LOCK_FILE}: it is not a regular file.`,
    );
    return;
  }
  const lock = contents === null ? null : parseSkillsLock(contents);
  if (lock === null) {
    ctx.ui.info(
      removedNames.length === 0
        ? `Keeping ${SKILLS_LOCK_FILE}: it has a format agemon doesn't know.`
        : `${SKILLS_LOCK_FILE} has a format agemon doesn't know; it may still list ${removedNames.map(printable).join(", ")}.`,
    );
    return;
  }

  const listedNames = removedNames.filter((name) =>
    Object.hasOwn(lock.skills, name),
  );
  for (const name of listedNames) {
    delete lock.skills[name];
  }
  const deletesFile = agemonOwnsLock && Object.keys(lock.skills).length === 0;
  if (listedNames.length === 0 && !deletesFile) {
    return;
  }
  if (ctx.dryRun) {
    ctx.ui.info(
      deletesFile
        ? `Would delete ${SKILLS_LOCK_FILE}`
        : `Would remove ${listedNames.map(printable).join(", ")} from ${SKILLS_LOCK_FILE}`,
    );
    return;
  }
  if (deletesFile) {
    if ((await lstatIfPresent(lockPath))?.isFile()) {
      await rm(lockPath, { force: true });
    }
    return;
  }
  await writeFileAtomic(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
