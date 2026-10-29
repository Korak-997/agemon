import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import type { Context } from "../../core/context.js";
import { readRegularFileIfExists } from "../../core/files.js";
import { isSameOrInside } from "../../core/repo-paths.js";
import { resolveStateRoot } from "../../core/state-root.js";
import { agemonSubprocessEnvironment } from "../../core/subprocess-runner.js";
import { isSafeIdentifier, printable } from "../../core/untrusted-text.js";
import {
  findBinaryPath,
  type PlatformCapabilities,
} from "../../platform/detect.js";
import {
  isHomeDirectory,
  isUsableAbsolutePath,
  resolveHomeDirectory,
} from "../../platform/home.js";
import { crgSubprocessEnvironment } from "./environment.js";

const CRG_BINARY_NAME = "code-review-graph";
export const BROKEN_PIPX_VENV_HINT = `pipx venv is broken — run 'pipx uninstall ${CRG_BINARY_NAME}', then 'agemon'`;
const PIPX_VENV_NAME = "code-review-graph";
const PACKAGE_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+!-]{0,63}$/;
const VERSION_IN_OUTPUT_PATTERN = /\d+(?:\.\d+){1,8}[0-9A-Za-z.+!-]{0,32}/;
const VERSION_CHECK_TIMEOUT_MS = 20_000;

export type CrgLocation =
  | {
      status: "found";
      source: "pipx" | "path";
      binaryPath: string;
      version: string;
      onPath: boolean;
      hashLocked: boolean;
    }
  | { status: "broken-venv" }
  | { status: "absent" };

type PipxLookup =
  | {
      status: "found";
      binaryPath: string;
      version: string;
      hashLocked: boolean;
    }
  | { status: "broken-venv" }
  | null;
type LocateContext = Pick<Context, "cwd" | "run" | "platform">;
type PathPolicy = (realPath: string) => boolean;

function isFakeSubprocessMode(): boolean {
  return process.env.AGEMON_FAKE_SUBPROCESS === "1";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePipxHome(
  family: PlatformCapabilities["family"],
): Promise<string> {
  if (isFakeSubprocessMode()) {
    const { fakePipxHome } = await import("../../core/fake-subprocess.js");
    return fakePipxHome();
  }

  const configured = process.env.PIPX_HOME;
  if (configured !== undefined) {
    if (!isUsableAbsolutePath(configured)) {
      throw new Error(
        `PIPX_HOME is set to '${printable(configured)}', which is not an absolute path without control characters or surrounding spaces. Fix or unset PIPX_HOME and run agemon again.`,
      );
    }
    return configured;
  }

  const home = resolveHomeDirectory();
  const legacyHome = join(home, ".local", "pipx");
  if (await pathExists(legacyHome)) {
    return legacyHome;
  }
  if (family === "darwin") {
    return join(home, "Library", "Application Support", "pipx");
  }
  const dataHome = process.env.XDG_DATA_HOME;
  if (dataHome && isAbsolute(dataHome)) {
    return join(dataHome, "pipx");
  }
  return join(home, ".local", "share", "pipx");
}

export function pipxMetadataPath(pipxHome: string): string {
  return join(pipxHome, "venvs", PIPX_VENV_NAME, "pipx_metadata.json");
}

async function readPipxMetadata(pipxHome: string): Promise<unknown> {
  try {
    const contents = await readRegularFileIfExists(pipxMetadataPath(pipxHome));
    return contents === null ? null : JSON.parse(contents);
  } catch {
    return null;
  }
}

const CONSTRAINTS_FILE_NAME_PATTERN =
  /^code-review-graph-constraints-[0-9a-f]{16}\.txt$/;

function isAgemonHashLock(pipArgs: unknown): boolean {
  if (!Array.isArray(pipArgs) || pipArgs.length !== 4) {
    return false;
  }
  const [requireHashes, onlyBinary, constraintFlag, constraintsPath] = pipArgs;
  return (
    requireHashes === "--require-hashes" &&
    onlyBinary === "--only-binary=:all:" &&
    constraintFlag === "-c" &&
    typeof constraintsPath === "string" &&
    isAbsolute(constraintsPath) &&
    resolve(constraintsPath) === constraintsPath &&
    dirname(constraintsPath) === join(resolveStateRoot(), "agemon", "tools") &&
    CONSTRAINTS_FILE_NAME_PATTERN.test(basename(constraintsPath))
  );
}

function pipxAppPath(
  metadata: unknown,
): { appPath: string; version: string; hashLocked: boolean } | null {
  const mainPackage = (metadata as { main_package?: unknown } | null)
    ?.main_package as
    | {
        package?: unknown;
        package_version?: unknown;
        app_paths?: unknown;
        pip_args?: unknown;
      }
    | undefined;
  if (
    mainPackage?.package !== PIPX_VENV_NAME ||
    typeof mainPackage.package_version !== "string" ||
    !PACKAGE_VERSION_PATTERN.test(mainPackage.package_version) ||
    !Array.isArray(mainPackage.app_paths)
  ) {
    return null;
  }

  const appPath = mainPackage.app_paths
    .map((entry) => (entry as { __Path__?: unknown } | null)?.__Path__)
    .find(
      (path): path is string =>
        typeof path === "string" &&
        isAbsolute(path) &&
        isSafeIdentifier(path) &&
        basename(path) === CRG_BINARY_NAME,
    );
  return appPath
    ? {
        appPath,
        version: mainPackage.package_version,
        hashLocked: isAgemonHashLock(mainPackage.pip_args),
      }
    : null;
}

async function locateInPipx(
  pipxHome: string,
  isAllowed: PathPolicy,
): Promise<PipxLookup> {
  const app = pipxAppPath(await readPipxMetadata(pipxHome));
  if (!app) {
    return null;
  }

  const venvPath = join(pipxHome, "venvs", PIPX_VENV_NAME);
  let realApp: string;
  try {
    const realVenv = await realpath(venvPath);
    realApp = await realpath(app.appPath);
    if (!isSameOrInside(realApp, realVenv) || !isAllowed(realApp)) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    await realpath(join(venvPath, "bin", "python"));
  } catch {
    return { status: "broken-venv" };
  }

  try {
    await access(realApp, constants.X_OK);
  } catch {
    return null;
  }
  return {
    status: "found",
    binaryPath: realApp,
    version: app.version,
    hashLocked: app.hashLocked,
  };
}

async function findOnPath(isAllowed: PathPolicy): Promise<string | undefined> {
  if (isFakeSubprocessMode()) {
    const { fakeCodeReviewGraphOnPath } = await import(
      "../../core/fake-subprocess.js"
    );
    return fakeCodeReviewGraphOnPath();
  }

  const allowedEntries: string[] = [];
  for (const entry of (agemonSubprocessEnvironment().PATH ?? "").split(
    delimiter,
  )) {
    if (!isAbsolute(entry)) {
      continue;
    }
    try {
      if (isAllowed(await realpath(entry))) {
        allowedEntries.push(entry);
      }
    } catch {}
  }

  const binaryPath = await findBinaryPath(
    CRG_BINARY_NAME,
    allowedEntries.join(delimiter),
  );
  if (binaryPath === undefined) {
    return undefined;
  }
  try {
    return isAllowed(await realpath(binaryPath)) ? binaryPath : undefined;
  } catch {
    return undefined;
  }
}

async function readPathBinaryVersion(
  ctx: LocateContext,
  binaryPath: string,
): Promise<string | null> {
  const versionCheck = await ctx.run(binaryPath, ["--version"], {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
    env: crgSubprocessEnvironment(),
  });
  if (versionCheck.code !== 0) {
    return null;
  }
  return (
    versionCheck.stdout.match(VERSION_IN_OUTPUT_PATTERN)?.[0] ??
    "version unknown"
  );
}

export async function locateCodeReviewGraph(
  ctx: LocateContext,
): Promise<CrgLocation> {
  const repoRoot = await realpath(ctx.cwd);
  const repoIsHome = await isHomeDirectory(repoRoot);
  const isAllowed: PathPolicy = (realPath) =>
    repoIsHome || !isSameOrInside(realPath, repoRoot);

  const binaryOnPath = await findOnPath(isAllowed);
  const pipxLocation = await locateInPipx(
    await resolvePipxHome(ctx.platform.family),
    isAllowed,
  );
  if (pipxLocation?.status === "broken-venv") {
    return pipxLocation;
  }
  if (pipxLocation?.status === "found") {
    return {
      status: "found",
      source: "pipx",
      binaryPath: pipxLocation.binaryPath,
      version: pipxLocation.version,
      onPath: binaryOnPath !== undefined,
      hashLocked: pipxLocation.hashLocked,
    };
  }

  if (binaryOnPath === undefined) {
    return { status: "absent" };
  }
  const version = await readPathBinaryVersion(ctx, binaryOnPath);
  return version === null
    ? { status: "absent" }
    : {
        status: "found",
        source: "path",
        binaryPath: binaryOnPath,
        version,
        onPath: true,
        hashLocked: false,
      };
}
