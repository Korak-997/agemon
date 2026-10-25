import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { isSafeIdentifier } from "../core/untrusted-text.js";

export function isUsableAbsolutePath(value: string): boolean {
  return isAbsolute(value) && value === value.trim() && isSafeIdentifier(value);
}

function accountHomeDirectory(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

export function resolveHomeDirectory(): string {
  for (const candidate of [process.env.HOME, accountHomeDirectory()]) {
    if (candidate && isUsableAbsolutePath(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "HOME is not an absolute path without control characters or surrounding spaces, and your account has no usable home directory. Set HOME to your home directory and run agemon again.",
  );
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function isHomeDirectory(realDirectory: string): Promise<boolean> {
  for (const candidate of [process.env.HOME, accountHomeDirectory()]) {
    if (
      candidate &&
      isAbsolute(candidate) &&
      (await realpathOrNull(candidate)) === realDirectory
    ) {
      return true;
    }
  }
  return false;
}
