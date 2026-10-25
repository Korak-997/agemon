import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT_SEARCH_DEPTH = 5;

let cachedPackageRoot: string | undefined;

function resolvePackageRoot(): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot;
  }

  let currentDir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < PACKAGE_ROOT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(currentDir, "assets", "skills"))) {
      cachedPackageRoot = currentDir;
      return currentDir;
    }
    currentDir = join(currentDir, "..");
  }

  throw new Error(
    "Unable to locate agemon's vendored assets/skills directory.",
  );
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
