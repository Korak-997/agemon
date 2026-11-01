import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { readRegularFileIfExists } from "./files.js";
import { printable } from "./untrusted-text.js";

const LOCK_FILE_MODE = 0o600;
const DEFAULT_POLL_MS = 200;
const UNREADABLE_LOCK_GRACE_MS = 30_000;
const STALE_BREAKER_AGE_MS = 60_000;
const BREAKER_SUFFIX = ".break";
const START_TIME_INDEX_AFTER_NAME = 19;
const SMALLEST_TRUSTED_PID = 2;
const SYSCTL_PATH = "/usr/sbin/sysctl";
const SYSCTL_TIMEOUT_MS = 5_000;
const SYSCTL_OUTPUT_LIMIT_BYTES = 1024;
const BOOT_SESSION_UUID_PATTERN =
  /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/iu;

export interface ProcessProbe {
  bootId(): Promise<string | null>;
  startTime(pid: number): Promise<string | null>;
  exists(pid: number): boolean;
}

export interface FileLockOptions {
  waitMs: number;
  pollMs?: number;
  probe?: ProcessProbe;
}

export interface HeldFileLock {
  assertStillHeld(): Promise<void>;
}

interface LockOwner {
  token: string;
  pid: number;
  bootId: string | null;
  startTime: string | null;
  acquiredAt: string;
}

const locksHeldByThisCallChain = new AsyncLocalStorage<ReadonlySet<string>>();

export function parseProcessStartTime(statContents: string): string | null {
  const endOfName = statContents.lastIndexOf(")");
  if (endOfName < 0) {
    return null;
  }
  const fieldsAfterName = statContents
    .slice(endOfName + 1)
    .trim()
    .split(/\s+/u);
  return fieldsAfterName[START_TIME_INDEX_AFTER_NAME] ?? null;
}

async function readTrimmedOrNull(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const linuxProcessProbe: ProcessProbe = {
  bootId: () => readTrimmedOrNull("/proc/sys/kernel/random/boot_id"),
  async startTime(pid) {
    const stat = await readTrimmedOrNull(`/proc/${pid}/stat`);
    return stat === null ? null : parseProcessStartTime(stat);
  },
  exists: processExists,
};

function readBootSessionUuidWithSysctl(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      SYSCTL_PATH,
      ["-n", "kern.bootsessionuuid"],
      { timeout: SYSCTL_TIMEOUT_MS, maxBuffer: SYSCTL_OUTPUT_LIMIT_BYTES },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export function createDarwinProcessProbe(
  readBootSessionUuid: () => Promise<string> = readBootSessionUuidWithSysctl,
): ProcessProbe {
  let bootId: Promise<string | null> | undefined;
  return {
    bootId() {
      bootId ??= readBootSessionUuid().then(
        (output) =>
          BOOT_SESSION_UUID_PATTERN.test(output.trim()) ? output.trim() : null,
        () => null,
      );
      return bootId;
    },
    startTime: async () => null,
    exists: processExists,
  };
}

const hostProcessProbe: ProcessProbe =
  process.platform === "darwin"
    ? createDarwinProcessProbe()
    : linuxProcessProbe;

function parseLockOwner(contents: string): LockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const owner = parsed as Record<string, unknown>;
  const isNullableString = (value: unknown) =>
    value === null || typeof value === "string";
  const hasTrustedPid =
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) >= SMALLEST_TRUSTED_PID;
  if (
    typeof owner.token !== "string" ||
    !hasTrustedPid ||
    !isNullableString(owner.bootId) ||
    !isNullableString(owner.startTime) ||
    typeof owner.acquiredAt !== "string"
  ) {
    return null;
  }
  return owner as unknown as LockOwner;
}

async function isOwnerAlive(
  owner: LockOwner,
  probe: ProcessProbe,
): Promise<boolean> {
  const currentBootId = await probe.bootId();
  if (currentBootId !== null && owner.bootId !== null) {
    if (owner.bootId !== currentBootId) {
      return false;
    }
    if (owner.startTime !== null) {
      return (await probe.startTime(owner.pid)) === owner.startTime;
    }
  }
  return probe.exists(owner.pid);
}

async function isOlderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await lstat(path)).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

async function isStaleLock(
  lockPath: string,
  contents: string,
  probe: ProcessProbe,
): Promise<boolean> {
  const owner = parseLockOwner(contents);
  if (owner === null) {
    return isOlderThan(lockPath, UNREADABLE_LOCK_GRACE_MS);
  }
  return !(await isOwnerAlive(owner, probe));
}

async function createLockFile(
  lockPath: string,
  contents: string,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", LOCK_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function breakStaleLock(
  lockPath: string,
  staleContents: string,
  probe: ProcessProbe,
): Promise<boolean> {
  const breakerPath = `${lockPath}${BREAKER_SUFFIX}`;
  if (!(await createLockFile(breakerPath, String(process.pid)))) {
    if (await isOlderThan(breakerPath, STALE_BREAKER_AGE_MS)) {
      await rm(breakerPath, { force: true });
    }
    return false;
  }
  try {
    if (
      (await readRegularFileIfExists(lockPath)) !== staleContents ||
      !(await isStaleLock(lockPath, staleContents, probe))
    ) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await rm(breakerPath, { force: true });
  }
}

function describeHolder(contents: string | null): string {
  const owner = contents === null ? null : parseLockOwner(contents);
  return owner === null
    ? "another agemon run"
    : `another agemon run (pid ${owner.pid}, since ${printable(owner.acquiredAt)})`;
}

async function acquireLock(
  lockPath: string,
  ownerContents: string,
  options: FileLockOptions,
  probe: ProcessProbe,
): Promise<void> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    if (await createLockFile(lockPath, ownerContents)) {
      return;
    }
    const existing = await readRegularFileIfExists(lockPath);
    if (existing === null) {
      continue;
    }
    if (
      (await isStaleLock(lockPath, existing, probe)) &&
      (await breakStaleLock(lockPath, existing, probe))
    ) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${describeHolder(existing)} holds ${printable(lockPath)}. Wait for it to finish; delete that file only if no agemon is running (an unreadable lock counts as stale after 30 s).`,
      );
    }
    await sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }
}

async function releaseLock(
  lockPath: string,
  ownerContents: string,
): Promise<void> {
  if ((await readRegularFileIfExists(lockPath)) === ownerContents) {
    await rm(lockPath, { force: true });
  }
}

export async function withFileLock<Result>(
  lockPath: string,
  work: (lock: HeldFileLock) => Promise<Result>,
  options: FileLockOptions,
): Promise<Result> {
  const heldLocks = locksHeldByThisCallChain.getStore() ?? new Set<string>();
  if (heldLocks.has(lockPath)) {
    throw new Error(
      `agemon tried to take ${printable(lockPath)} while already holding it.`,
    );
  }

  const probe = options.probe ?? hostProcessProbe;
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    bootId: await probe.bootId(),
    startTime: await probe.startTime(process.pid),
    acquiredAt: new Date().toISOString(),
  };
  const ownerContents = JSON.stringify(owner);
  await acquireLock(lockPath, ownerContents, options, probe);

  const held: HeldFileLock = {
    async assertStillHeld() {
      if ((await readRegularFileIfExists(lockPath)) !== ownerContents) {
        throw new Error(
          `agemon's lock ${printable(lockPath)} was removed or replaced by another run; nothing more was changed. Run agemon again.`,
        );
      }
    },
  };
  try {
    return await locksHeldByThisCallChain.run(
      new Set([...heldLocks, lockPath]),
      () => work(held),
    );
  } finally {
    await releaseLock(lockPath, ownerContents);
  }
}
