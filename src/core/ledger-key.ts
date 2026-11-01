import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegularFileIfExists } from "./files.js";
import {
  resolveAgemonStateDirectory,
  type StateDirectoryMode,
  withAgemonStateLock,
} from "./state-root.js";
import { printable } from "./untrusted-text.js";

const LEDGER_KEY_FILE_NAME = "ledger-key";
const LEDGER_KEY_LOCK_FILE_NAME = "ledger-key.lock";
const LEDGER_KEY_LOCK_WAIT_MS = 60_000;
const LEDGER_KEY_BYTES = 32;
const LEDGER_KEY_FILE_MODE = 0o600;
const GROUP_AND_OTHER_PERMISSIONS = 0o077;
const LEDGER_KEY_PATTERN = /^[0-9a-f]{64}\n?$/u;

function invalidKey(path: string, reason: string): Error {
  return new Error(
    `agemon's ledger key ${printable(path)} is invalid: ${reason}. Move it aside to continue; agemon then treats every existing ledger entry as unconfirmed.`,
  );
}

async function ledgerKeyPath(mode: StateDirectoryMode): Promise<string> {
  return join(
    (await resolveAgemonStateDirectory(mode)).path,
    LEDGER_KEY_FILE_NAME,
  );
}

async function readKeyAt(path: string): Promise<Buffer | null> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw invalidKey(path, "it is not a regular file");
  }
  if (stats.uid !== process.getuid?.()) {
    throw invalidKey(path, "it is owned by another user");
  }
  if (stats.mode & GROUP_AND_OTHER_PERMISSIONS) {
    throw invalidKey(path, "other users can read or change it");
  }
  const contents = await readRegularFileIfExists(path);
  if (contents === null || !LEDGER_KEY_PATTERN.test(contents)) {
    throw invalidKey(path, "it does not hold 64 hexadecimal characters");
  }
  return Buffer.from(contents.trim(), "hex");
}

export async function readLedgerKey(): Promise<Buffer | null> {
  return readKeyAt(await ledgerKeyPath("check"));
}

async function publishNewKey(path: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(
    temporaryPath,
    `${randomBytes(LEDGER_KEY_BYTES).toString("hex")}\n`,
    { mode: LEDGER_KEY_FILE_MODE, flag: "wx" },
  );
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function ensureLedgerKey(): Promise<Buffer> {
  const path = await ledgerKeyPath("prepare");
  return withAgemonStateLock(
    LEDGER_KEY_LOCK_FILE_NAME,
    async () => {
      const existing = await readKeyAt(path);
      if (existing !== null) {
        return existing;
      }
      await publishNewKey(path);
      const created = await readKeyAt(path);
      if (created === null) {
        throw invalidKey(path, "it disappeared right after agemon created it");
      }
      return created;
    },
    LEDGER_KEY_LOCK_WAIT_MS,
  );
}
