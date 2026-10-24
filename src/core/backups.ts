import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  NotARegularFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { sha256Hex } from "./fingerprint.js";

const BACKUP_DIRECTORY = ".agemon/backups";
const RESOURCE_ID_HASH_LENGTH = 12;

export interface WrittenBackup {
  path: string;
  checksum: string;
  created: boolean;
}

export interface FoundBackup {
  path: string;
  contents: string;
}

export function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export function resolveImmutableBackupPath(
  cwd: string,
  resourceId: string,
): string {
  const resourceIdHash = sha256Hex(resourceId).slice(
    0,
    RESOURCE_ID_HASH_LENGTH,
  );
  return join(
    cwd,
    BACKUP_DIRECTORY,
    `${sanitizeForFileName(resourceId)}-${resourceIdHash}.bak`,
  );
}

function resolveLegacyBackupPath(cwd: string, resourceId: string): string {
  return join(cwd, BACKUP_DIRECTORY, `${sanitizeForFileName(resourceId)}.bak`);
}

function isDirectlyInBackupDirectory(cwd: string, filePath: string): boolean {
  return (
    isAbsolute(filePath) &&
    dirname(resolve(filePath)) === join(cwd, BACKUP_DIRECTORY)
  );
}

async function writeBackup(
  backupPath: string,
  contents: string,
): Promise<WrittenBackup> {
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFileAtomic(backupPath, contents);
  return { path: backupPath, checksum: sha256Hex(contents), created: true };
}

export async function writeImmutableBackup(
  cwd: string,
  resourceId: string,
  contents: string,
): Promise<WrittenBackup> {
  const backupPath = resolveImmutableBackupPath(cwd, resourceId);
  const existingBackup = await readRegularFileIfExists(backupPath);
  if (existingBackup !== null) {
    return {
      path: backupPath,
      checksum: sha256Hex(existingBackup),
      created: false,
    };
  }
  return writeBackup(backupPath, contents);
}

export async function replaceStaleBackup(
  cwd: string,
  resourceId: string,
  contents: string,
): Promise<WrittenBackup> {
  const backupPath = resolveImmutableBackupPath(cwd, resourceId);
  if ((await readRegularFileIfExists(backupPath)) === contents) {
    return { path: backupPath, checksum: sha256Hex(contents), created: false };
  }
  return writeBackup(backupPath, contents);
}

export function immutableBackupCandidates(
  cwd: string,
  resourceId: string,
  recordedPath: string | null,
): string[] {
  const candidates = [
    resolveImmutableBackupPath(cwd, resourceId),
    resolveLegacyBackupPath(cwd, resourceId),
  ];
  if (recordedPath !== null && isDirectlyInBackupDirectory(cwd, recordedPath)) {
    candidates.unshift(recordedPath);
  }
  return [...new Set(candidates)];
}

export async function readFirstExistingBackup(
  candidatePaths: string[],
): Promise<FoundBackup | null> {
  for (const candidatePath of candidatePaths) {
    try {
      const contents = await readRegularFileIfExists(candidatePath);
      if (contents !== null) {
        return { path: candidatePath, contents };
      }
    } catch (error) {
      if (!(error instanceof NotARegularFileError)) {
        throw error;
      }
    }
  }
  return null;
}
