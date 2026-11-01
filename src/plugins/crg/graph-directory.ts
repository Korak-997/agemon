import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../../core/error-message.js";
import { hasGitEntry, isMissingPathError } from "../../core/repo-paths.js";
import { runRepositoryGit } from "../../core/repository-git.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";
import { printable, quoteForShlex } from "../../core/untrusted-text.js";

export const GRAPH_DIRECTORY = ".code-review-graph";
const LEGACY_ROOT_DATABASE = ".code-review-graph.db";
const LEGACY_ROOT_DATABASE_FILES = [
  LEGACY_ROOT_DATABASE,
  `${LEGACY_ROOT_DATABASE}-wal`,
  `${LEGACY_ROOT_DATABASE}-shm`,
  `${LEGACY_ROOT_DATABASE}-journal`,
];

export const PATHS_CRG_WRITES_THROUGH = [
  GRAPH_DIRECTORY,
  ...[
    ".gitignore",
    "graph.db",
    "graph.db-wal",
    "graph.db-shm",
    "graph.db-journal",
    "graph.html",
    "wiki",
  ].map((name) => `${GRAPH_DIRECTORY}/${name}`),
  LEGACY_ROOT_DATABASE,
];

const TRACKED_PATHSPECS = [GRAPH_DIRECTORY, ...LEGACY_ROOT_DATABASE_FILES].map(
  (path) => `:(top,icase)${path}`,
);
const MAX_CHECKED_ENTRIES = 20_000;
const MAX_NAMED_TRACKED_ENTRIES = 5;

const GRAPH_ENTRY_NOT_DIRECTORY = `${GRAPH_DIRECTORY} is a symlink or file, not a directory; remove it, then run code-review-graph build`;
const TOO_MANY_ENTRIES = `${GRAPH_DIRECTORY} has more than 20 000 entries, so agemon can't check it for links; remove the directory (code-review-graph build recreates it) and run agemon again.`;

type EntryType =
  | "file"
  | "directory"
  | "symlink"
  | "fifo"
  | "socket"
  | "device"
  | "unknown";

const ENTRY_TYPE_DESCRIPTIONS: Record<EntryType, string> = {
  file: "a regular file",
  directory: "a directory",
  symlink: "a symlink",
  fifo: "a FIFO",
  socket: "a socket",
  device: "a device",
  unknown: "of an unknown type",
};

export async function graphDirectoryProblem(
  repoRoot: string,
): Promise<string | null> {
  const trackedProblem = await trackedGraphContentProblem(repoRoot);
  if (trackedProblem !== null) {
    return trackedProblem;
  }
  try {
    return (
      (await graphDirectoryContentProblem(repoRoot)) ??
      (await legacyRootDatabaseProblem(repoRoot))
    );
  } catch (error) {
    return `could not check ${GRAPH_DIRECTORY} for links: ${printable(errorMessage(error))}`;
  }
}

async function trackedGraphContentProblem(
  repoRoot: string,
): Promise<string | null> {
  const result = await runRepositoryGit(repoRoot, [
    "ls-files",
    "-z",
    "--",
    ...TRACKED_PATHSPECS,
  ]);
  if (result.code !== 0) {
    return (await hasGitEntry(repoRoot))
      ? `could not check whether ${GRAPH_DIRECTORY} is tracked: ${describeSubprocessFailure(result, "git ls-files")}`
      : null;
  }
  const trackedPaths = result.stdout.split("\0").filter(Boolean);
  if (trackedPaths.length === 0) {
    return null;
  }
  const trackedEntries = [...new Set(trackedPaths.map(topLevelEntryOf))];
  const namedEntries = trackedEntries
    .slice(0, MAX_NAMED_TRACKED_ENTRIES)
    .map((entry) => printable(quoteForShlex(entry)));
  const more =
    trackedEntries.length > MAX_NAMED_TRACKED_ENTRIES ? " and more" : "";
  return `${trackedPaths.length} path(s) where crg writes its graph are tracked by git; crg would write through repository content. Remove them from the repository (git rm -r --cached -- ${namedEntries.join(" ")}${more}) and run agemon again.`;
}

function topLevelEntryOf(trackedPath: string): string {
  const components = trackedPath.split("/");
  const firstEntryIndex = components.findIndex((part) => part !== "..");
  return components.slice(0, firstEntryIndex + 1).join("/");
}

async function graphDirectoryContentProblem(
  repoRoot: string,
): Promise<string | null> {
  const graphType = await lstatEntryType(join(repoRoot, GRAPH_DIRECTORY));
  if (graphType === "missing") {
    return null;
  }
  if (graphType !== "directory") {
    return GRAPH_ENTRY_NOT_DIRECTORY;
  }
  return await findEntryCrgWouldWriteThrough(repoRoot);
}

async function findEntryCrgWouldWriteThrough(
  repoRoot: string,
): Promise<string | null> {
  const directoriesToCheck = [GRAPH_DIRECTORY];
  let checkedEntries = 0;
  for (
    let directory = directoriesToCheck.pop();
    directory !== undefined;
    directory = directoriesToCheck.pop()
  ) {
    const entries = await readDirectoryUnlessGone(join(repoRoot, directory));
    for (const entry of entries) {
      checkedEntries += 1;
      if (checkedEntries > MAX_CHECKED_ENTRIES) {
        return TOO_MANY_ENTRIES;
      }
      const path = `${directory}/${entry.name}`;
      const type = await resolvedEntryType(join(repoRoot, path), entry);
      if (type === "directory") {
        directoriesToCheck.push(path);
      } else if (type !== "file" && type !== "missing") {
        return `${printable(path)} is ${ENTRY_TYPE_DESCRIPTIONS[type]}, not a regular file or directory; crg would write through it. Remove ${GRAPH_DIRECTORY} (code-review-graph build recreates it) and run agemon again.`;
      }
    }
  }
  return null;
}

async function readDirectoryUnlessGone(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

async function resolvedEntryType(
  path: string,
  entry: Dirent,
): Promise<EntryType | "missing"> {
  const reportedType = entryTypeOf(entry);
  return reportedType === "unknown" ? await lstatEntryType(path) : reportedType;
}

async function legacyRootDatabaseProblem(
  repoRoot: string,
): Promise<string | null> {
  for (const name of LEGACY_ROOT_DATABASE_FILES) {
    const type = await lstatEntryType(join(repoRoot, name));
    if (type !== "missing" && type !== "file") {
      return `${name} at the repository root is ${ENTRY_TYPE_DESCRIPTIONS[type]}, not a regular file; crg would write through it. Remove it and run agemon again.`;
    }
  }
  return null;
}

async function lstatEntryType(path: string): Promise<EntryType | "missing"> {
  try {
    return entryTypeOf(await lstat(path));
  } catch (error) {
    if (isMissingPathError(error)) {
      return "missing";
    }
    throw error;
  }
}

function entryTypeOf(entry: Dirent | Stats): EntryType {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isFIFO()) {
    return "fifo";
  }
  if (entry.isSocket()) {
    return "socket";
  }
  if (entry.isBlockDevice() || entry.isCharacterDevice()) {
    return "device";
  }
  return "unknown";
}
