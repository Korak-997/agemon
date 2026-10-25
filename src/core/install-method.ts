import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalNpmRoot } from "./npm-global.js";
import { runSubprocess } from "./subprocess-runner.js";
import type { RunSubprocess } from "./subprocess-trace.js";

const PACKAGE_NAME = "agemon";
const PACKAGE_JSON_SEARCH_DEPTH = 5;
export const INSTALL_MARKER_FILE_NAME = ".agemon-install";
const SOURCE_CHECKOUT_ENTRIES = [".git", "src"];
const NPX_CACHE_SEGMENT = "_npx";

export type InstallMethod =
  | { kind: "install-script"; installDir: string }
  | { kind: "npm-global"; packageRoot: string; prefix: string }
  | { kind: "npx" }
  | { kind: "dev" }
  | { kind: "unknown"; packageRoot: string };

function readPackageName(directory: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    return (manifest as { name?: string }).name;
  } catch {
    return undefined;
  }
}

export function resolvePackageRoot(
  fromDirectory = dirname(fileURLToPath(import.meta.url)),
): string {
  let directory = fromDirectory;
  for (let depth = 0; depth < PACKAGE_JSON_SEARCH_DEPTH; depth += 1) {
    if (readPackageName(directory) === PACKAGE_NAME) {
      return realpathSync(directory);
    }
    directory = dirname(directory);
  }
  throw new Error("Unable to locate agemon's package.json.");
}

export function readPackageVersion(packageRoot = resolvePackageRoot()): string {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

function isSourceCheckout(packageRoot: string): boolean {
  return (
    process.env.AGEMON_DEV === "1" ||
    SOURCE_CHECKOUT_ENTRIES.some((entry) =>
      existsSync(join(packageRoot, entry)),
    )
  );
}

async function hasRegularInstallMarker(packageRoot: string): Promise<boolean> {
  try {
    return (await lstat(join(packageRoot, INSTALL_MARKER_FILE_NAME))).isFile();
  } catch {
    return false;
  }
}

function isInsideNodeModules(packageRoot: string): boolean {
  return basename(dirname(packageRoot)) === "node_modules";
}

async function resolveGlobalNpmPrefix(
  packageRoot: string,
  run: RunSubprocess,
): Promise<string | undefined> {
  try {
    const globalRoot = await realpath(await resolveGlobalNpmRoot(run));
    const globalRootHoldsThisCopy = globalRoot === dirname(packageRoot);
    const globalRootIsPrefixLib = basename(dirname(globalRoot)) === "lib";
    return globalRootHoldsThisCopy && globalRootIsPrefixLib
      ? dirname(dirname(globalRoot))
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveInstallMethod(
  options: { packageRoot?: string; run?: RunSubprocess } = {},
): Promise<InstallMethod> {
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  if (isSourceCheckout(packageRoot)) {
    return { kind: "dev" };
  }
  if (await hasRegularInstallMarker(packageRoot)) {
    return { kind: "install-script", installDir: packageRoot };
  }
  if (packageRoot.split(sep).includes(NPX_CACHE_SEGMENT)) {
    return { kind: "npx" };
  }
  if (isInsideNodeModules(packageRoot)) {
    const prefix = await resolveGlobalNpmPrefix(
      packageRoot,
      options.run ?? runSubprocess,
    );
    if (prefix !== undefined) {
      return { kind: "npm-global", packageRoot, prefix };
    }
  }
  return { kind: "unknown", packageRoot };
}
