import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "./fingerprint.js";

const BACKUP_DIRECTORY = ".agemon/backups";

export interface ImmutableBackup {
  path: string;
  checksum: string;
}

function encodeResourceIdAsFileName(resourceId: string): string {
  return resourceId.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export function resolveImmutableBackupPath(
  cwd: string,
  resourceId: string,
): string {
  return join(
    cwd,
    BACKUP_DIRECTORY,
    `${encodeResourceIdAsFileName(resourceId)}.bak`,
  );
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writeImmutableBackup(
  cwd: string,
  resourceId: string,
  contents: string,
): Promise<ImmutableBackup> {
  const backupPath = resolveImmutableBackupPath(cwd, resourceId);
  const existingBackup = await readFileIfExists(backupPath);
  if (existingBackup !== null) {
    return { path: backupPath, checksum: sha256Hex(existingBackup) };
  }

  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, contents, "utf8");
  return { path: backupPath, checksum: sha256Hex(contents) };
}
