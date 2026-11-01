import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { HeldFileLock } from "./file-lock.js";
import { readRegularFileIfExists, writeFileAtomic } from "./files.js";
import {
  resolveAgemonStateDirectory,
  withAgemonStateLock,
} from "./state-root.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const MACHINE_LEDGER_VERSION = 1;
const MACHINE_LEDGER_FILE_NAME = "machine.json";
const MACHINE_LOCK_FILE_NAME = "machine.lock";
const MACHINE_LEDGER_FILE_MODE = 0o600;
const MACHINE_LOCK_WAIT_MS = 10 * 60_000;
export const MAX_SHARED_RESOURCE_HOLDERS = 1000;

const SHARED_RESOURCE_IDS = [
  "pipx:code-review-graph",
  "npm-global:agnix",
  "linger",
] as const;

export type SharedResourceId = (typeof SHARED_RESOURCE_IDS)[number];

const DIRECTORY_ID_PATTERN = /^\d+:\d+:\d+$/u;

export type SharedResourceRecord =
  | {
      origin: "installed";
      installedBy: string;
      ownerDirectoryId: string;
      holders: string[];
    }
  | {
      origin: "migrated";
      claimedBy: string;
      ownerDirectoryId: string;
      holders: string[];
    }
  | { origin: "pre-existing"; holders: string[] };

interface MachineLedger {
  version: typeof MACHINE_LEDGER_VERSION;
  resources: Partial<Record<SharedResourceId, SharedResourceRecord>>;
}

interface SharedResourceChange<Result> {
  record: SharedResourceRecord | null;
  result: Result;
}

export function isRecordableRepositoryPath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && isSafeIdentifier(path);
}

export async function directoryIdentity(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  } catch {
    return null;
  }
}

interface DirectoryTimes {
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
}

export interface ReceiptIdentities {
  signing: string;
  byBirthTime: string | null;
  byPath: string;
  usableBirthTimeMs: number | null;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const ENTRY_CLOCK_TOLERANCE_MS = 1_000;

export function receiptIdentitiesFromStats(
  stats: DirectoryTimes,
  realpathOfDirectory: string,
): ReceiptIdentities {
  const byBirthTime =
    stats.birthtimeNs === 0n ? null : `${stats.ino}:${stats.birthtimeNs}`;
  const byPath = `${stats.ino}:${realpathOfDirectory}`;
  const birthTimeIsUsable =
    byBirthTime !== null && stats.birthtimeNs !== stats.ctimeNs;
  return {
    signing: birthTimeIsUsable ? byBirthTime : byPath,
    byBirthTime,
    byPath,
    usableBirthTimeMs: birthTimeIsUsable
      ? Number(stats.birthtimeNs / NANOSECONDS_PER_MILLISECOND)
      : null,
  };
}

export function identitiesAcceptingEntry(
  identities: ReceiptIdentities,
  entryCreatedAt: string,
): string[] {
  const createdAtMs = Date.parse(entryCreatedAt);
  const pathFormIsPlausible =
    identities.usableBirthTimeMs === null ||
    createdAtMs >= identities.usableBirthTimeMs - ENTRY_CLOCK_TOLERANCE_MS;
  return [
    ...(identities.byBirthTime === null ? [] : [identities.byBirthTime]),
    ...(pathFormIsPlausible ? [identities.byPath] : []),
  ];
}

export async function repositoryReceiptIdentities(
  repoRoot: string,
): Promise<ReceiptIdentities> {
  const realpathOfRepository = await realpath(repoRoot);
  return receiptIdentitiesFromStats(
    await lstat(realpathOfRepository, { bigint: true }),
    realpathOfRepository,
  );
}

function hasTrustworthyBirthTime(directoryId: string): boolean {
  return !directoryId.endsWith(":0");
}

function validateMachineLedger(parsed: unknown, path: string): MachineLedger {
  const fail = (detail: string): never => {
    throw new Error(
      `The shared-tools ledger ${printable(path)} is invalid: ${detail}. Move it aside to continue; agemon then keeps every shared tool installed until each repository registers again.`,
    );
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const repositoryPath = (value: unknown, field: string): string =>
    typeof value === "string" && isRecordableRepositoryPath(value)
      ? value
      : fail(`'${field}' must be an absolute, normalised path`);
  const directoryId = (value: unknown, field: string): string =>
    typeof value === "string" && DIRECTORY_ID_PATTERN.test(value)
      ? value
      : fail(`'${field}' must be a directory identity`);

  if (!isRecord(parsed) || parsed.version !== MACHINE_LEDGER_VERSION) {
    return fail(`expected version ${MACHINE_LEDGER_VERSION}`);
  }
  if (!isRecord(parsed.resources)) {
    return fail("'resources' must be an object");
  }

  const resources: MachineLedger["resources"] = {};
  for (const [resourceId, value] of Object.entries(parsed.resources)) {
    if (!SHARED_RESOURCE_IDS.includes(resourceId as SharedResourceId)) {
      fail(`unknown resource '${printable(resourceId)}'`);
    }
    const field = (name: string) => `resources.${resourceId}.${name}`;
    const record = isRecord(value)
      ? value
      : fail(`'resources.${resourceId}' must be an object`);
    if (!Array.isArray(record.holders)) {
      fail(`'${field("holders")}' must be an array`);
    }
    const holders = (record.holders as unknown[]).map((holder, index) =>
      repositoryPath(holder, `${field("holders")}[${index}]`),
    );
    if (new Set(holders).size !== holders.length) {
      fail(`'${field("holders")}' lists a repository twice`);
    }
    if (holders.length > MAX_SHARED_RESOURCE_HOLDERS) {
      fail(
        `'${field("holders")}' has more than ${MAX_SHARED_RESOURCE_HOLDERS} entries`,
      );
    }
    resources[resourceId as SharedResourceId] =
      record.origin === "installed"
        ? {
            origin: "installed",
            installedBy: repositoryPath(
              record.installedBy,
              field("installedBy"),
            ),
            ownerDirectoryId: directoryId(
              record.ownerDirectoryId,
              field("ownerDirectoryId"),
            ),
            holders,
          }
        : record.origin === "migrated"
          ? {
              origin: "migrated",
              claimedBy: repositoryPath(record.claimedBy, field("claimedBy")),
              ownerDirectoryId: directoryId(
                record.ownerDirectoryId,
                field("ownerDirectoryId"),
              ),
              holders,
            }
          : record.origin === "pre-existing"
            ? { origin: "pre-existing", holders }
            : fail(
                `'${field("origin")}' must be installed, migrated or pre-existing`,
              );
  }
  return { version: MACHINE_LEDGER_VERSION, resources };
}

async function machineLedgerPath(mode: "check" | "prepare"): Promise<string> {
  return join(
    (await resolveAgemonStateDirectory(mode)).path,
    MACHINE_LEDGER_FILE_NAME,
  );
}

async function readLedgerAt(ledgerPath: string): Promise<MachineLedger> {
  const contents = await readRegularFileIfExists(ledgerPath);
  if (contents === null) {
    return { version: MACHINE_LEDGER_VERSION, resources: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    parsed = null;
  }
  return validateMachineLedger(parsed, ledgerPath);
}

export async function readMachineLedger(): Promise<MachineLedger> {
  return readLedgerAt(await machineLedgerPath("check"));
}

async function pathIsGone(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function withoutMissingHolders(
  holders: string[],
  reportPruned: (holder: string) => void,
): Promise<string[]> {
  const existing: string[] = [];
  for (const holder of holders) {
    if (await pathIsGone(holder)) {
      reportPruned(holder);
    } else {
      existing.push(holder);
    }
  }
  return existing;
}

export async function withoutReplacedOwner(
  record: SharedResourceRecord,
): Promise<SharedResourceRecord> {
  if (record.origin === "pre-existing") {
    return record;
  }
  const owner =
    record.origin === "installed" ? record.installedBy : record.claimedBy;
  return hasTrustworthyBirthTime(record.ownerDirectoryId) &&
    (await directoryIdentity(owner)) === record.ownerDirectoryId
    ? record
    : { origin: "pre-existing", holders: record.holders };
}

export async function withMachineLedgerLock<Result>(
  work: () => Promise<Result>,
): Promise<Result> {
  return withAgemonStateLock(
    MACHINE_LOCK_FILE_NAME,
    () => work(),
    MACHINE_LOCK_WAIT_MS,
  );
}

export async function updateSharedResource<Result>(
  resourceId: SharedResourceId,
  change: (
    record: SharedResourceRecord | null,
    lock: HeldFileLock,
  ) => Promise<SharedResourceChange<Result>>,
  reportPruned: (holder: string) => void,
): Promise<Result> {
  const ledgerPath = await machineLedgerPath("prepare");
  return withAgemonStateLock(
    MACHINE_LOCK_FILE_NAME,
    async (lock) => {
      const ledger = await readLedgerAt(ledgerPath);
      const stored = ledger.resources[resourceId] ?? null;
      const current =
        stored === null
          ? null
          : await withoutReplacedOwner({
              ...stored,
              holders: await withoutMissingHolders(
                stored.holders,
                reportPruned,
              ),
            });
      const { record, result } = await change(current, lock);

      const next: MachineLedger = {
        version: MACHINE_LEDGER_VERSION,
        resources: { ...ledger.resources },
      };
      if (record === null) {
        delete next.resources[resourceId];
      } else {
        next.resources[resourceId] = record;
      }
      try {
        validateMachineLedger(next, ledgerPath);
      } catch (error) {
        throw new Error(
          `agemon refused to write an invalid shared-tools ledger (a bug in agemon): ${(error as Error).message}`,
        );
      }
      await lock.assertStillHeld();
      if (Object.keys(next.resources).length === 0) {
        await rm(ledgerPath, { force: true });
      } else {
        await writeFileAtomic(
          ledgerPath,
          `${JSON.stringify(next, null, 2)}\n`,
          { newFileMode: MACHINE_LEDGER_FILE_MODE },
        );
      }
      return result;
    },
    MACHINE_LOCK_WAIT_MS,
  );
}
