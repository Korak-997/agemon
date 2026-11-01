import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "agemon";
const PACKAGE_MANIFEST = "package.json";
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;

let cachedPackageRoot: string | undefined;

function readPackageName(manifestPath: string): string | null {
  const stats = lstatSync(manifestPath);
  if (!stats.isFile() || stats.size > MAX_PACKAGE_MANIFEST_BYTES) {
    return null;
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      typeof manifest.name === "string"
      ? manifest.name
      : null;
  } catch {
    return null;
  }
}

function findNearestPackageDirectory(startDirectory: string): string | null {
  let currentDir = startDirectory;
  for (;;) {
    if (existsSync(join(currentDir, PACKAGE_MANIFEST))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function resolvePackageRootFrom(startDirectory: string): string {
  const packageDirectory = findNearestPackageDirectory(startDirectory);
  if (
    packageDirectory === null ||
    readPackageName(join(packageDirectory, PACKAGE_MANIFEST)) !==
      PACKAGE_NAME ||
    !existsSync(join(packageDirectory, "assets", "skills"))
  ) {
    throw new Error(
      "Unable to locate agemon's vendored assets/skills directory.",
    );
  }
  return packageDirectory;
}

function resolvePackageRoot(): string {
  cachedPackageRoot ??= resolvePackageRootFrom(
    dirname(fileURLToPath(import.meta.url)),
  );
  return cachedPackageRoot;
}

export function resolveVendoredSkillPath(
  groupId: string,
  skillId: string,
): string {
  return join(resolvePackageRoot(), "assets", "skills", groupId, skillId);
}

export function resolveToolsManifestDirectory(): string {
  return join(resolvePackageRoot(), "assets", "tools");
}
