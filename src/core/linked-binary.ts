import {
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { resolveHomeDirectory } from "../platform/home.js";
import { currentUid } from "./install-location.js";
import { isSameOrInside } from "./repo-paths.js";
import { printable } from "./untrusted-text.js";

const ROOT_UID = 0;
const ROOT_TOOLS_ROOT = "/usr/local/lib/agemon-tools";
const ROOT_LINK_DIRECTORY = "/usr/local/bin";
const USER_TOOLS_ROOT_IN_HOME = join(".local", "share", "agemon-tools");
const USER_LINK_DIRECTORY_IN_HOME = join(".local", "bin");

export interface LinkedBinaryPaths {
  toolsRoot: string;
  binaryPath: string;
  linkPath: string;
}

export type LinkedBinaryState =
  | "absent"
  | "ours-current"
  | "ours-other-version"
  | "foreign";

export function linkedBinaryPaths(
  toolId: string,
  version: string,
  binaryName: string,
  uid = currentUid(),
  home = resolveHomeDirectory(),
): LinkedBinaryPaths {
  const isRoot = uid === ROOT_UID;
  const toolsRoot = isRoot
    ? ROOT_TOOLS_ROOT
    : join(home, USER_TOOLS_ROOT_IN_HOME);
  const linkDirectory = isRoot
    ? ROOT_LINK_DIRECTORY
    : join(home, USER_LINK_DIRECTORY_IN_HOME);
  return {
    toolsRoot,
    binaryPath: join(toolsRoot, toolId, version, binaryName),
    linkPath: join(linkDirectory, binaryName),
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) {
      return path;
    }
    throw error;
  }
}

async function resolveLinkTarget(linkPath: string): Promise<string> {
  try {
    return await realpath(linkPath);
  } catch (error) {
    if (isMissing(error)) {
      return resolve(dirname(linkPath), await readlink(linkPath));
    }
    throw error;
  }
}

export async function inspectLinkedBinary(
  paths: LinkedBinaryPaths,
): Promise<LinkedBinaryState> {
  let linkStats: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStats = await lstat(paths.linkPath);
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
  if (!linkStats.isSymbolicLink()) {
    return "foreign";
  }
  const target = await resolveLinkTarget(paths.linkPath);
  if (!isSameOrInside(target, await realpathOrSelf(paths.toolsRoot))) {
    return "foreign";
  }
  return target === (await realpathOrSelf(paths.binaryPath))
    ? "ours-current"
    : "ours-other-version";
}

export async function assertLinkPathIsFree(
  paths: LinkedBinaryPaths,
): Promise<void> {
  if ((await inspectLinkedBinary(paths)) === "foreign") {
    throw new Error(
      `${printable(paths.linkPath)} already exists and was not installed by agemon; remove it or keep using your own ${basename(paths.linkPath)}`,
    );
  }
}

export async function linkBinary(paths: LinkedBinaryPaths): Promise<void> {
  await assertLinkPathIsFree(paths);
  await mkdir(dirname(paths.linkPath), { recursive: true });
  const stagedLinkPath = `${paths.linkPath}.agemon-${process.pid}`;
  await rm(stagedLinkPath, { force: true });
  await symlink(paths.binaryPath, stagedLinkPath);
  await rename(stagedLinkPath, paths.linkPath);
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

export async function removeVersionDirectory(
  paths: LinkedBinaryPaths,
): Promise<void> {
  const versionDirectory = dirname(paths.binaryPath);
  await rm(versionDirectory, { recursive: true, force: true });
  await removeDirectoryIfEmpty(dirname(versionDirectory));
  await removeDirectoryIfEmpty(paths.toolsRoot);
}

export async function unlinkBinary(paths: LinkedBinaryPaths): Promise<void> {
  const state = await inspectLinkedBinary(paths);
  if (state === "foreign") {
    return;
  }
  if (state !== "absent") {
    await rm(paths.linkPath);
  }
  const toolDirectory = dirname(dirname(paths.binaryPath));
  await rm(toolDirectory, { recursive: true, force: true });
  await removeDirectoryIfEmpty(paths.toolsRoot);
}

export async function isDirectoryOnPath(
  directory: string,
  pathVariable = process.env.PATH ?? "",
): Promise<boolean> {
  const wanted = await realpathOrSelf(directory);
  for (const entry of pathVariable.split(delimiter)) {
    if (entry.length > 0 && (await realpathOrSelf(resolve(entry))) === wanted) {
      return true;
    }
  }
  return false;
}
