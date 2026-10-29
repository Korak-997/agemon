import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegularFileIfExists, writeFileAtomic } from "../../core/files.js";
import { sha256Hex } from "../../core/fingerprint.js";
import { resolveToolsManifestDirectory } from "../../core/package-assets.js";
import { prepareToolsRoot } from "../../core/state-root.js";
import { quoteForShlex } from "../../core/untrusted-text.js";

const CONSTRAINTS_FILE_NAME = "code-review-graph-constraints.txt";
const CONSTRAINTS_HASH_LENGTH = 16;

export async function ensureCrgConstraintsFile(): Promise<string> {
  const shippedConstraints = await readFile(
    join(resolveToolsManifestDirectory(), CONSTRAINTS_FILE_NAME),
    "utf8",
  );
  const toolsRoot = await prepareToolsRoot();
  const constraintsPath = join(
    toolsRoot,
    `code-review-graph-constraints-${sha256Hex(shippedConstraints).slice(0, CONSTRAINTS_HASH_LENGTH)}.txt`,
  );
  if ((await readRegularFileIfExists(constraintsPath)) !== shippedConstraints) {
    await writeFileAtomic(constraintsPath, shippedConstraints);
  }
  return constraintsPath;
}

export function hashLockedPipArgs(constraintsPath: string): string {
  return `--pip-args=--require-hashes --only-binary=:all: -c ${quoteForShlex(constraintsPath)}`;
}
