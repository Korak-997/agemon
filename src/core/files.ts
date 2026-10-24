import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";

const OWNER_ONLY_MODE = 0o600;
const DEFAULT_NEW_FILE_MODE = 0o666;
const PERMISSION_BITS = 0o777;

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class NotARegularFileError extends Error {
  constructor(action: "read" | "write", filePath: string) {
    super(
      `Refusing to ${action} ${filePath}: it is not a regular file (agemon does not ${action} through symlinks or special files).`,
    );
    this.name = "NotARegularFileError";
  }
}

export async function readFileIfExists(
  filePath: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
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
    return await handle.readFile("utf8");
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
): Promise<void> {
  const existingMode = await modeOfReplaceableFile(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  const handle = await open(
    tempPath,
    "wx",
    existingMode === null ? DEFAULT_NEW_FILE_MODE : OWNER_ONLY_MODE,
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
