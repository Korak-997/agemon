import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT_SEARCH_DEPTH = 5;

// This file's own directory differs between dev (src/plugins/skills/, run via
// tsx) and the built/installed layout (dist/index.js) — walk up until
// assets/skills/ is found rather than hardcoding a relative path that would
// only match one of the two layouts. Mirrors resolvePackageVersion() in
// src/cli/index.ts.
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

/**
 * Resolves the on-disk path to a vendored skill shipped with agemon itself,
 * for use as a `skills add` local-path source — no dependency on GitHub
 * being reachable at bootstrap time for these groups.
 */
export function resolveVendoredSkillPath(
  groupId: string,
  skillId: string,
): string {
  return join(resolvePackageRoot(), "assets", "skills", groupId, skillId);
}
