import { lstat, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { describeSubprocessFailure } from "./subprocess-runner.js";
import type { RunSubprocess } from "./subprocess-trace.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const NPM_ROOT_TIMEOUT_MS = 20_000;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function resolveGlobalNpmRoot(
  run: RunSubprocess,
  options: { cwd?: string; mayNotExistYet?: boolean } = {},
): Promise<string> {
  const npmRootResult = await run("npm", ["root", "--global"], {
    timeoutMs: NPM_ROOT_TIMEOUT_MS,
    cwd: options.cwd,
  });
  if (npmRootResult.code !== 0) {
    throw new Error(
      `npm root --global failed: ${describeSubprocessFailure(npmRootResult, "npm")}`,
    );
  }
  const npmRoot = npmRootResult.stdout.trim();
  if (!isAbsolute(npmRoot)) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not an absolute path.`,
    );
  }
  if (resolve(npmRoot) !== npmRoot || !isSafeIdentifier(npmRoot)) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not a single normalised path.`,
    );
  }
  if (options.mayNotExistYet && (await pathIsMissing(npmRoot))) {
    return npmRoot;
  }
  if (!(await isDirectory(npmRoot))) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not a directory. npm masks UUID-like path segments as ***; use an npm prefix without one.`,
    );
  }
  return npmRoot;
}
