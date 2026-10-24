import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";

const OWNER_ONLY_MODE = 0o600;
const DEFAULT_NEW_FILE_MODE = 0o666;
const PERMISSION_BITS = 0o777;
const READ_CHUNK_BYTES = 64 * 1024;
const PRESERVED_ORIGINAL_SUFFIX = ".agemon-original";

const BYTES_PER_MEBIBYTE = 1024 * 1024;

export const MAX_READ_FILE_BYTES = 8 * BYTES_PER_MEBIBYTE;
export const MAX_READ_FILE_LABEL = `${MAX_READ_FILE_BYTES / BYTES_PER_MEBIBYTE} MiB`;

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class RefusedFileError extends Error {}

export class NotARegularFileError extends RefusedFileError {
  constructor(action: "read" | "write", filePath: string) {
    super(
      `Refusing to ${action} ${filePath}: it is not a regular file (agemon does not ${action} through symlinks or special files).`,
    );
    this.name = "NotARegularFileError";
  }
}

export class FileTooLargeError extends RefusedFileError {
  constructor(filePath: string) {
    super(
      `Refusing to read ${filePath}: it is larger than ${MAX_READ_FILE_LABEL}.`,
    );
    this.name = "FileTooLargeError";
  }
}

export class RefusedPathError extends RefusedFileError {
  constructor(message: string) {
    super(message);
    this.name = "RefusedPathError";
  }
}

async function readAtMostCap(
  handle: FileHandle,
  filePath: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (;;) {
    const { bytesRead, buffer } = await handle.read({
      buffer: Buffer.alloc(READ_CHUNK_BYTES),
    });
    if (bytesRead === 0) {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    }
    totalBytes += bytesRead;
    if (totalBytes > MAX_READ_FILE_BYTES) {
      throw new FileTooLargeError(filePath);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
}

export async function readRegularFileIfExists(
  filePath: string,
): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new NotARegularFileError("read", filePath);
    }
    throw error;
  }

  try {
    if (!(await handle.stat()).isFile()) {
      throw new NotARegularFileError("read", filePath);
    }
    return await readAtMostCap(handle, filePath);
  } finally {
    await handle.close();
  }
}

async function modeOfReplaceableFile(filePath: string): Promise<number | null> {
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  if (!existing.isFile()) {
    throw new NotARegularFileError("write", filePath);
  }
  try {
    await access(filePath, constants.W_OK);
  } catch {
    throw new Error(
      `Refusing to write ${filePath}: it is read-only for this user.`,
    );
  }
  return existing.mode & PERMISSION_BITS;
}

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: { newFileMode?: number } = {},
): Promise<void> {
  const existingMode = await modeOfReplaceableFile(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  const handle = await open(
    tempPath,
    "wx",
    existingMode === null
      ? (options.newFileMode ?? DEFAULT_NEW_FILE_MODE)
      : OWNER_ONLY_MODE,
  );
  try {
    try {
      if (existingMode !== null) {
        await handle.chmod(existingMode);
      }
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeNewFile(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, "wx", OWNER_ONLY_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeNewFileWithFallback(
  preferredPath: string,
  fallbackPath: string,
  contents: string,
): Promise<string> {
  try {
    await writeNewFile(preferredPath, contents);
    return preferredPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await writeNewFile(fallbackPath, contents);
  return fallbackPath;
}

export async function saveVerifiedCopyBeside(
  targetPath: string,
  contents: string,
): Promise<string> {
  const preferredPath = `${targetPath}${PRESERVED_ORIGINAL_SUFFIX}`;
  const savedPath = await writeNewFileWithFallback(
    preferredPath,
    `${preferredPath}.${Date.now()}`,
    contents,
  );
  if ((await readRegularFileIfExists(savedPath)) !== contents) {
    throw new Error(`Could not verify the copy saved at ${savedPath}`);
  }
  return savedPath;
}
