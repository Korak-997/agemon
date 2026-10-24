import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  FileTooLargeError,
  NotARegularFileError,
  RefusedPathError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { sha256Hex } from "./fingerprint.js";
import { AGEMON_STATE_DIRECTORY, resolveStateDirectory } from "./repo-paths.js";
import { printable } from "./untrusted-text.js";

const BACKUP_SEGMENTS = ["backups"];
const V1_BACKUP_SEGMENTS = ["backups", "master-prompt"];
const BACKUP_DIRECTORY = join(AGEMON_STATE_DIRECTORY, ...BACKUP_SEGMENTS);
const V1_BACKUP_DIRECTORY = join(AGEMON_STATE_DIRECTORY, ...V1_BACKUP_SEGMENTS);
const RESOURCE_ID_HASH_LENGTH = 12;

export interface WrittenBackup {
  path: string;
  checksum: string;
}

export interface FoundBackup {
  path: string;
  contents: string;
}

function sanitizeForFileName(value: string): string {
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

export function resolveV1RuleFileBackupPath(
  cwd: string,
  target: string,
): string {
  return join(cwd, V1_BACKUP_DIRECTORY, `${sanitizeForFileName(target)}.bak`);
}

function backupDirectorySegments(
  cwd: string,
  backupPath: string,
): string[] | null {
  const directory = dirname(backupPath);
  if (directory === join(cwd, BACKUP_DIRECTORY)) {
    return BACKUP_SEGMENTS;
  }
  if (directory === join(cwd, V1_BACKUP_DIRECTORY)) {
    return V1_BACKUP_SEGMENTS;
  }
  return null;
}

async function writeBackup(
  cwd: string,
  backupPath: string,
  contents: string,
): Promise<WrittenBackup> {
  await resolveStateDirectory(cwd, BACKUP_SEGMENTS, { create: true });
  await writeFileAtomic(backupPath, contents);
  return { path: backupPath, checksum: sha256Hex(contents) };
}

export async function writeImmutableBackup(
  cwd: string,
  resourceId: string,
  contents: string,
): Promise<WrittenBackup> {
  const backupPath = resolveImmutableBackupPath(cwd, resourceId);
  const existingBackup = await readBackupFile(cwd, backupPath);
  if (existingBackup !== null) {
    return { path: backupPath, checksum: sha256Hex(existingBackup) };
  }
  return writeBackup(cwd, backupPath, contents);
}

export async function replaceStaleBackup(
  cwd: string,
  resourceId: string,
  contents: string,
): Promise<WrittenBackup> {
  const backupPath = resolveImmutableBackupPath(cwd, resourceId);
  if ((await readBackupFile(cwd, backupPath)) === contents) {
    return { path: backupPath, checksum: sha256Hex(contents) };
  }
  return writeBackup(cwd, backupPath, contents);
}

export function immutableBackupCandidates(
  cwd: string,
  resourceId: string,
  recordedPath: string | null,
): string[] {
  const ownBackupPaths = [
    resolveImmutableBackupPath(cwd, resourceId),
    resolveLegacyBackupPath(cwd, resourceId),
  ];
  const recordedOwnPath =
    recordedPath !== null && isAbsolute(recordedPath)
      ? ownBackupPaths.find((ownPath) => ownPath === resolve(recordedPath))
      : undefined;
  return recordedOwnPath === undefined
    ? ownBackupPaths
    : [
        recordedOwnPath,
        ...ownBackupPaths.filter((ownPath) => ownPath !== recordedOwnPath),
      ];
}

async function readBackupFile(
  cwd: string,
  backupPath: string,
): Promise<string | null> {
  const segments = backupDirectorySegments(cwd, backupPath);
  if (segments === null) {
    throw new RefusedPathError(
      `Refusing to use ${printable(backupPath)}: it is not in agemon's backup directory.`,
    );
  }
  const backupDirectory = await resolveStateDirectory(cwd, segments, {
    create: false,
  });
  return backupDirectory === null ? null : readRegularFileIfExists(backupPath);
}

export async function readFirstExistingBackup(
  cwd: string,
  candidatePaths: string[],
): Promise<FoundBackup | null> {
  for (const candidatePath of candidatePaths) {
    try {
      const contents = await readBackupFile(cwd, candidatePath);
      if (contents !== null) {
        return { path: candidatePath, contents };
      }
    } catch (error) {
      if (
        !(error instanceof NotARegularFileError) &&
        !(error instanceof FileTooLargeError)
      ) {
        throw error;
      }
    }
  }
  return null;
}
