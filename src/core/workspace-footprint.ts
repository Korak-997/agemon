import { lstat, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "./context.js";
import {
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { fingerprintContent } from "./fingerprint.js";
import {
  AGEMON_GITIGNORE_ENTRY as AGEMON_LINE,
  type GitignoreWrite,
  gitignoreListsEntry,
  SKILLS_LOCK_GITIGNORE_ENTRY as SKILLS_LOCK_LINE,
} from "./gitignore.js";
import { AGEMON_STATE_DIRECTORY, resolveRepoDirectory } from "./repo-paths.js";
import type { LedgerEntry } from "./state-manifest.js";

export const WORKSPACE_PLUGIN_ID = "workspace";

const GITIGNORE_FILE = ".gitignore";
const GITIGNORE_LINE_TYPE = "gitignore-line";
const CREATED_DIRECTORY_TYPE = "created-directory";
const SKILLS_LOCK_FILE = "skills-lock.json";
const RECORDABLE_LINES: readonly string[] = [AGEMON_LINE, SKILLS_LOCK_LINE];
const RECORDABLE_DIRECTORIES: readonly string[] = [
  ".claude",
  ".claude/skills",
  ".claude/agents",
];
const LINE_TERMINATOR = /\r?\n$/u;
const AFTER_EACH_LINE_TERMINATOR = /(?<=\n)/u;

function gitignoreLineResourceId(line: string): string {
  return `${GITIGNORE_LINE_TYPE}:${line}`;
}

function createdDirectoryResourceId(directory: string): string {
  return `${CREATED_DIRECTORY_TYPE}:${directory}`;
}

export async function recordGitignoreLine(
  ctx: Context,
  line: string,
  write: GitignoreWrite,
): Promise<void> {
  if (!write.added || !RECORDABLE_LINES.includes(line)) {
    return;
  }
  await ctx.manifest.recordAction({
    plugin: WORKSPACE_PLUGIN_ID,
    type: GITIGNORE_LINE_TYPE,
    target: GITIGNORE_FILE,
    resourceId: gitignoreLineResourceId(line),
    preExisting: write.existedBefore,
    fingerprintBefore:
      write.contentsBefore === null
        ? null
        : fingerprintContent(write.contentsBefore),
  });
}

export async function recordCreatedDirectories(
  ctx: Context,
  createdDirectories: string[],
): Promise<void> {
  for (const directory of createdDirectories) {
    if (RECORDABLE_DIRECTORIES.includes(directory)) {
      await ctx.manifest.recordAction({
        plugin: WORKSPACE_PLUGIN_ID,
        type: CREATED_DIRECTORY_TYPE,
        target: directory,
        resourceId: createdDirectoryResourceId(directory),
        preExisting: false,
      });
    }
  }
}

export function isWorkspaceEntry(entry: LedgerEntry): boolean {
  return entry.plugin === WORKSPACE_PLUGIN_ID;
}

function recordedLine(entry: LedgerEntry): string | null {
  if (
    !isWorkspaceEntry(entry) ||
    entry.type !== GITIGNORE_LINE_TYPE ||
    entry.target !== GITIGNORE_FILE
  ) {
    return null;
  }
  return (
    RECORDABLE_LINES.find(
      (line) => entry.resourceId === gitignoreLineResourceId(line),
    ) ?? null
  );
}

function recordedDirectory(entry: LedgerEntry): string | null {
  return isWorkspaceEntry(entry) &&
    entry.type === CREATED_DIRECTORY_TYPE &&
    RECORDABLE_DIRECTORIES.includes(entry.target) &&
    entry.resourceId === createdDirectoryResourceId(entry.target)
    ? entry.target
    : null;
}

function recordedLines(entries: LedgerEntry[]): Set<string> {
  return new Set(
    entries.map(recordedLine).filter((line): line is string => line !== null),
  );
}

export function isCreatedDirectoryEntry(entry: LedgerEntry): boolean {
  return recordedDirectory(entry) !== null;
}

function depth(directory: string): number {
  return directory.split("/").length;
}

function deepestFirst(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (left, right) => depth(right.target) - depth(left.target),
  );
}

function confirmedDirectoryEntries(ctx: Context): LedgerEntry[] {
  return ctx.manifest
    .getActions()
    .filter(
      (entry) =>
        isCreatedDirectoryEntry(entry) && ctx.manifest.isConfirmed(entry),
    );
}

function newestFirstConfirmedLineEntries(ctx: Context): LedgerEntry[] {
  return ctx.manifest
    .getActions()
    .filter(
      (entry) =>
        recordedLine(entry) !== null && ctx.manifest.isConfirmed(entry),
    )
    .reverse();
}

export async function removeEmptyDirectories(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<Set<string>> {
  const goneEntryIds = new Set<string>();
  for (const entry of deepestFirst(entries)) {
    const directory = recordedDirectory(entry);
    if (directory === null) {
      continue;
    }
    try {
      const path = await resolveRepoDirectory(ctx.cwd, directory);
      if (path !== null) {
        await rmdir(path);
      }
      goneEntryIds.add(entry.id);
    } catch {
      // rmdir never deletes content: a non-empty, symlinked or busy directory stays with its entry.
    }
  }
  return goneEntryIds;
}

export async function removeRecordedEmptyDirectories(
  ctx: Context,
): Promise<void> {
  const goneEntryIds = await removeEmptyDirectories(
    ctx,
    confirmedDirectoryEntries(ctx),
  );
  await ctx.manifest.removeActionIds([...goneEntryIds]);
}

export function describeDirectoryRemoval(entries: LedgerEntry[]): string[] {
  const directories = new Set(
    deepestFirst(entries.filter(isCreatedDirectoryEntry)).map(
      (entry) => entry.target,
    ),
  );
  return directories.size === 0
    ? []
    : [
        `remove empty directories agemon created: ${[...directories].join(", ")}`,
      ];
}

export function describeFootprintRemoval(
  ctx: Context,
  removesLastCapability: boolean,
): string[] {
  const lines = describeDirectoryRemoval(confirmedDirectoryEntries(ctx));
  const linesToRemove = recordedLines(newestFirstConfirmedLineEntries(ctx));
  if (removesLastCapability && linesToRemove.size > 0) {
    lines.push(
      `remove from ${GITIGNORE_FILE}: ${[...linesToRemove].join(", ")} (added by agemon)`,
    );
  }
  return lines;
}

function withoutLastExactLine(contents: string, line: string): string | null {
  const lines = contents.split(AFTER_EACH_LINE_TERMINATOR);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].replace(LINE_TERMINATOR, "") === line) {
      lines.splice(index, 1);
      return lines.join("");
    }
  }
  return null;
}

function withSeparatorAgemonAddedUndone(
  entry: LedgerEntry,
  contents: string,
): string {
  const withoutFinalTerminator = contents.replace(LINE_TERMINATOR, "");
  return entry.fingerprintBefore !== null &&
    fingerprintContent(contents) !== entry.fingerprintBefore &&
    fingerprintContent(withoutFinalTerminator) === entry.fingerprintBefore
    ? withoutFinalTerminator
    : contents;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function removeRecordedLine(
  ctx: Context,
  line: string,
  entries: LedgerEntry[],
  agemonCreatedGitignore: boolean,
): Promise<void> {
  const gitignorePath = join(ctx.cwd, GITIGNORE_FILE);
  for (const entry of entries) {
    let contents: string | null;
    try {
      contents = await readRegularFileIfExists(gitignorePath);
    } catch (error) {
      if (!(error instanceof RefusedFileError)) {
        throw error;
      }
      ctx.ui.info(
        `Keeping ${line} in ${GITIGNORE_FILE}: ${GITIGNORE_FILE} is not a regular file.`,
      );
      return;
    }
    const remaining =
      contents === null ? null : withoutLastExactLine(contents, line);
    if (remaining === null) {
      continue;
    }
    const restored = withSeparatorAgemonAddedUndone(entry, remaining);
    if (restored === "" && agemonCreatedGitignore) {
      if ((await lstat(gitignorePath)).isFile()) {
        await rm(gitignorePath);
      }
      return;
    }
    await writeFileAtomic(gitignorePath, restored);
  }
}

function reportClaimedLines(ctx: Context, confirmedLines: Set<string>): void {
  const claimedLines = recordedLines(
    ctx.manifest
      .getActions()
      .filter((entry) => !ctx.manifest.isConfirmed(entry)),
  );
  for (const line of claimedLines) {
    if (!confirmedLines.has(line)) {
      ctx.ui.info(
        `Keeping ${line} in ${GITIGNORE_FILE}: agemon has no record on this machine that it added it.`,
      );
    }
  }
}

async function reportUnrecordedLines(ctx: Context): Promise<void> {
  let contents: string | null;
  try {
    contents = await readRegularFileIfExists(join(ctx.cwd, GITIGNORE_FILE));
  } catch {
    return;
  }
  const leftLines = RECORDABLE_LINES.filter(
    (line) => contents !== null && gitignoreListsEntry(contents, line),
  );
  if (leftLines.length === 0) {
    return;
  }
  const pronoun = leftLines.length === 1 ? "it" : "them";
  ctx.ui.info(
    `Left ${leftLines.join(" and ")} in ${GITIGNORE_FILE}: agemon has no record of adding ${pronoun}. Remove ${pronoun} if you no longer need ${pronoun}.`,
  );
}

export async function removeWorkspaceFootprint(ctx: Context): Promise<void> {
  const hasAnyLineEntry = ctx.manifest
    .getActions()
    .some((entry) => recordedLine(entry) !== null);
  const lineEntries = newestFirstConfirmedLineEntries(ctx);
  const agemonCreatedGitignore = lineEntries.some(
    (entry) => !entry.preExisting,
  );
  const removeLineUnless = async (
    line: string,
    stillNeededPath: string,
    keepReason: string,
  ) => {
    const entries = lineEntries.filter((entry) => recordedLine(entry) === line);
    if (entries.length === 0) {
      return;
    }
    if (await exists(join(ctx.cwd, stillNeededPath))) {
      ctx.ui.info(`Keeping ${line} in ${GITIGNORE_FILE}: ${keepReason}`);
      return;
    }
    await removeRecordedLine(ctx, line, entries, agemonCreatedGitignore);
  };
  reportClaimedLines(ctx, recordedLines(lineEntries));
  if (!hasAnyLineEntry) {
    await reportUnrecordedLines(ctx);
  }

  await removeLineUnless(
    SKILLS_LOCK_LINE,
    SKILLS_LOCK_FILE,
    `${SKILLS_LOCK_FILE} still exists`,
  );
  await ctx.manifest.removeActionsForPlugin(WORKSPACE_PLUGIN_ID);
  await ctx.manifest.pruneIfEmpty();
  await removeLineUnless(
    AGEMON_LINE,
    AGEMON_STATE_DIRECTORY,
    `${AGEMON_STATE_DIRECTORY}/ still exists`,
  );
}
