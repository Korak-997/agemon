import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type Snapshot = Map<string, string>;

async function collectFilePaths(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFilePaths(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

export async function snapshotTree(root: string): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const rootExists = await stat(root).catch(() => null);
  if (!rootExists) return snapshot;

  const filePaths: string[] = [];
  await collectFilePaths(root, filePaths);

  for (const filePath of filePaths) {
    const contents = await readFile(filePath);
    const hash = createHash("sha256").update(contents).digest("hex");
    snapshot.set(relative(root, filePath), hash);
  }

  return snapshot;
}

export interface DiffLine {
  kind: "added" | "removed" | "changed";
  path: string;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffLine[] {
  const diff: DiffLine[] = [];

  for (const [path, hash] of after) {
    if (!before.has(path)) {
      diff.push({ kind: "added", path });
    } else if (before.get(path) !== hash) {
      diff.push({ kind: "changed", path });
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) {
      diff.push({ kind: "removed", path });
    }
  }

  return diff.sort((a, b) => a.path.localeCompare(b.path));
}

const DIFF_SYMBOLS = { added: "+", removed: "-", changed: "~" } as const;

export function formatDiff(diff: DiffLine[]): string {
  if (diff.length === 0) return "(no changes)";
  return diff
    .map((line) => `${DIFF_SYMBOLS[line.kind]} ${line.path}`)
    .join("\n");
}
