import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefusedPathError } from "./files.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

export const AGEMON_STATE_DIRECTORY = ".agemon";
const GIT_DIRECTORY = ".git";
const IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}/gu;
const MAX_PATH_COMPONENT_BYTES = 255;
const GITDIR_FILE_PREFIX = "gitdir:";
const GITDIR_FILE_PROBE_BYTES = 4096;

export interface RepositoryRoot {
  root: string;
  notice: string | null;
}

type GitEntryKind = "none" | "repository" | "unacceptable" | "unreadable";

interface GitEntry {
  kind: GitEntryKind;
  ownerUid: number | null;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function refuseRepoPath(relativePath: string, reason: string): never {
  throw new RefusedPathError(
    `Refusing to use '${printable(relativePath)}': ${reason}. agemon only touches files inside the repository.`,
  );
}

async function resolveRealDirectory(
  repoRoot: string,
  components: string[],
  options: { create: boolean },
): Promise<string | null> {
  let current = repoRoot;
  for (const component of components) {
    current = join(current, component);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      if (!options.create) {
        return null;
      }
      await mkdir(current);
      continue;
    }
    if (!stats.isDirectory()) {
      throw new RefusedPathError(
        `Refusing to use ${printable(current)}: it is a symlink or not a directory. agemon only uses real directories here — replace it with a real directory.`,
      );
    }
  }
  return current;
}

function foldForCaseInsensitiveFilesystems(component: string): string {
  return component.replace(IGNORABLE_CODE_POINTS, "").toLowerCase();
}

export async function resolveInsideRepo(
  repoRoot: string,
  relativePath: string,
): Promise<string> {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    refuseRepoPath(relativePath, "it is empty or contains a NUL byte");
  }
  if (isAbsolute(relativePath)) {
    refuseRepoPath(relativePath, "it is an absolute path");
  }
  if (!isSafeIdentifier(relativePath)) {
    refuseRepoPath(relativePath, "it contains control characters");
  }

  const repoRelativePath = relative(repoRoot, resolve(repoRoot, relativePath));
  if (
    repoRelativePath === "" ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith(`..${sep}`)
  ) {
    refuseRepoPath(relativePath, "it resolves outside the repository");
  }

  const components = repoRelativePath.split(sep);
  if (
    components.some(
      (component) => Buffer.byteLength(component) > MAX_PATH_COMPONENT_BYTES,
    )
  ) {
    refuseRepoPath(relativePath, "a path component is longer than 255 bytes");
  }
  const foldedComponents = components.map(foldForCaseInsensitiveFilesystems);
  if (foldedComponents.includes(GIT_DIRECTORY)) {
    refuseRepoPath(relativePath, "it is inside a .git directory");
  }
  if (foldedComponents[0] === AGEMON_STATE_DIRECTORY) {
    refuseRepoPath(relativePath, "it is inside agemon's own .agemon/ state");
  }

  await resolveRealDirectory(repoRoot, components.slice(0, -1), {
    create: false,
  });
  return join(repoRoot, repoRelativePath);
}

export function resolveStateDirectory(
  repoRoot: string,
  segments: string[],
  options: { create: true },
): Promise<string>;
export function resolveStateDirectory(
  repoRoot: string,
  segments: string[],
  options: { create: boolean },
): Promise<string | null>;
export async function resolveStateDirectory(
  repoRoot: string,
  segments: string[],
  options: { create: boolean },
): Promise<string | null> {
  return resolveRealDirectory(
    repoRoot,
    [AGEMON_STATE_DIRECTORY, ...segments],
    options,
  );
}

export async function resolveRepoDirectory(
  repoRoot: string,
  relativeDirectory: string,
  options: { create: boolean } = { create: false },
): Promise<string | null> {
  return resolveRealDirectory(repoRoot, relativeDirectory.split("/"), options);
}

async function readRegularFilePrefix(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      return null;
    }
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function classifyGitEntry(directory: string): Promise<GitEntry> {
  const gitPath = join(directory, GIT_DIRECTORY);
  try {
    const stats = await lstat(gitPath);
    const entry = (kind: GitEntryKind): GitEntry => ({
      kind,
      ownerUid: stats.uid,
    });
    if (stats.isDirectory()) {
      return entry("repository");
    }
    if (!stats.isFile()) {
      return entry("unacceptable");
    }
    const prefix = await readRegularFilePrefix(
      gitPath,
      GITDIR_FILE_PROBE_BYTES,
    );
    return entry(
      prefix?.startsWith(GITDIR_FILE_PREFIX) ? "repository" : "unacceptable",
    );
  } catch (error) {
    return {
      kind: isMissingPathError(error) ? "none" : "unreadable",
      ownerUid: null,
    };
  }
}

export async function hasGitEntry(directory: string): Promise<boolean> {
  return (await classifyGitEntry(directory)).kind !== "none";
}

async function isOwnedBy(
  directory: string,
  gitEntry: GitEntry,
  uid: number | undefined,
): Promise<boolean> {
  if (uid === undefined) {
    return true;
  }
  return gitEntry.ownerUid === uid && (await lstat(directory)).uid === uid;
}

async function realpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export function isSameOrInside(path: string, ancestor: string): boolean {
  const pathFromAncestor = relative(ancestor, path);
  return (
    pathFromAncestor === "" ||
    (pathFromAncestor !== ".." &&
      !pathFromAncestor.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromAncestor))
  );
}

export async function resolveRepositoryRoot(
  cwd: string,
  homeDirectory: string = homedir(),
  currentUid: number | undefined = process.getuid?.(),
): Promise<RepositoryRoot> {
  const start = await realpath(cwd);
  const home = await realpathOrResolved(homeDirectory);
  const useStart = (notice: string | null): RepositoryRoot => ({
    root: start,
    notice,
  });
  const notUsing = (directory: string, reason: string): RepositoryRoot =>
    useStart(
      `Not using ${printable(directory)} as the repository root (${reason}).`,
    );

  for (let directory = start; ; directory = dirname(directory)) {
    const gitEntry = await classifyGitEntry(directory);
    if (gitEntry.kind === "unreadable") {
      return useStart(null);
    }
    if (gitEntry.kind !== "none" && directory === start) {
      return useStart(null);
    }
    if (gitEntry.kind === "unacceptable") {
      return notUsing(directory, "its .git is not a directory or gitdir file");
    }
    if (gitEntry.kind === "repository") {
      if (isSameOrInside(home, directory)) {
        return useStart(
          `Not using ${printable(directory)} as the repository root (it contains your home directory); run 'git init' here or run agemon from the repository root.`,
        );
      }
      if (!(await isOwnedBy(directory, gitEntry, currentUid))) {
        return notUsing(directory, "it is owned by another user");
      }
      return {
        root: directory,
        notice: `Using repository root ${printable(directory)} (not the current directory).`,
      };
    }
    if (dirname(directory) === directory) {
      return useStart(null);
    }
  }
}
