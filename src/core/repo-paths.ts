import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefusedPathError } from "./files.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

export const AGEMON_STATE_DIRECTORY = ".agemon";
const GIT_DIRECTORY = ".git";
const MAX_PATH_COMPONENT_BYTES = 255;

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
  if (components.includes(GIT_DIRECTORY)) {
    refuseRepoPath(relativePath, "it is inside a .git directory");
  }
  if (components[0] === AGEMON_STATE_DIRECTORY) {
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
): Promise<string | null> {
  return resolveRealDirectory(repoRoot, relativeDirectory.split("/"), {
    create: false,
  });
}
