import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_READ_FILE_BYTES,
  MAX_READ_FILE_LABEL,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { type LedgerEntry, parseLedgerEntries } from "./state-manifest.js";
import {
  repositoryStateKey,
  resolveAgemonStateDirectory,
  type StateDirectoryMode,
} from "./state-root.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY_MODE = 0o700;
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_FILE_NAME_PATTERN = /^([0-9a-f]{16})\.json$/u;

export interface JournalSnapshot {
  targetPath: string;
  previousContents: string | null;
  stagedFingerprint: string | null;
}

export interface ApplyJournal {
  version: typeof JOURNAL_VERSION;
  planId: string;
  repoRoot: string;
  startedAt: string;
  capabilityOrder: string[];
  ledgerBefore: LedgerEntry[];
  snapshots: JournalSnapshot[];
}

export interface StoredJournal {
  path: string;
  journal: ApplyJournal;
}

export type NewApplyJournal = Omit<ApplyJournal, "version" | "repoRoot">;

export async function resolveJournalDirectory(
  repoRoot: string,
  mode: StateDirectoryMode = "check",
): Promise<string> {
  return join(
    (await resolveAgemonStateDirectory(mode)).path,
    "journals",
    await repositoryStateKey(repoRoot),
  );
}

export async function writeJournal(
  repoRoot: string,
  newJournal: NewApplyJournal,
): Promise<StoredJournal> {
  const journal: ApplyJournal = {
    version: JOURNAL_VERSION,
    repoRoot: await realpath(repoRoot),
    ...newJournal,
  };
  const payload = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(payload) > MAX_READ_FILE_BYTES) {
    throw new Error(
      `Refusing to apply: the rollback journal would exceed ${MAX_READ_FILE_LABEL} (${journal.snapshots.length} rule files). Shrink them or apply fewer capabilities with --only.`,
    );
  }

  const directory = await resolveJournalDirectory(repoRoot, "prepare");
  await mkdir(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  const path = join(directory, `${journal.planId}.json`);
  await writeFileAtomic(path, payload, { newFileMode: JOURNAL_FILE_MODE });
  return { path, journal };
}

export async function deleteJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

function validateJournal(
  parsed: unknown,
  expectedPlanId: string,
  expectedRepoRoot: string,
): ApplyJournal {
  const fail = (detail: string): never => {
    throw new Error(detail);
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const identifier = (value: unknown, field: string): string =>
    typeof value === "string" && isSafeIdentifier(value)
      ? value
      : fail(`'${field}' must be a string without control characters`);
  const nullableIdentifier = (value: unknown, field: string): string | null =>
    value === null ? null : identifier(value, field);
  const list = (value: unknown, field: string): unknown[] =>
    Array.isArray(value) ? value : fail(`'${field}' must be an array`);

  if (!isRecord(parsed)) {
    return fail("it is not a JSON object");
  }
  if (parsed.version !== JOURNAL_VERSION) {
    fail(`unknown version ${printable(String(parsed.version))}`);
  }
  if (parsed.planId !== expectedPlanId) {
    fail("its plan id does not match its file name");
  }
  if (parsed.repoRoot !== expectedRepoRoot) {
    fail(
      `it belongs to another repository (${printable(String(parsed.repoRoot))})`,
    );
  }

  return {
    version: JOURNAL_VERSION,
    planId: expectedPlanId,
    repoRoot: expectedRepoRoot,
    startedAt: identifier(parsed.startedAt, "startedAt"),
    capabilityOrder: list(parsed.capabilityOrder, "capabilityOrder").map(
      (value, index) => identifier(value, `capabilityOrder[${index}]`),
    ),
    ledgerBefore:
      parseLedgerEntries(parsed.ledgerBefore) ??
      fail("'ledgerBefore' is not a list of valid ledger entries"),
    snapshots: list(parsed.snapshots, "snapshots").map((value, index) => {
      const field = (name: string) => `snapshots[${index}].${name}`;
      const snapshot = isRecord(value)
        ? value
        : fail(`'snapshots[${index}]' must be an object`);
      const { previousContents } = snapshot;
      return {
        targetPath: identifier(snapshot.targetPath, field("targetPath")),
        previousContents:
          previousContents === null || typeof previousContents === "string"
            ? previousContents
            : fail(`'${field("previousContents")}' must be a string or null`),
        stagedFingerprint: nullableIdentifier(
          snapshot.stagedFingerprint,
          field("stagedFingerprint"),
        ),
      };
    }),
  };
}

export function invalidJournalError(path: string, detail: string): Error {
  return new Error(
    `The interrupted-apply journal ${path} is invalid: ${detail}. Delete it to continue; agemon then cannot restore what that apply changed.`,
  );
}

async function readJournal(
  path: string,
  planId: string,
  repoRoot: string,
): Promise<ApplyJournal | null> {
  try {
    const contents = await readRegularFileIfExists(path);
    return contents === null
      ? null
      : validateJournal(JSON.parse(contents), planId, repoRoot);
  } catch (error) {
    throw invalidJournalError(path, printable((error as Error).message));
  }
}

async function listJournalFileNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readJournals(repoRoot: string): Promise<StoredJournal[]> {
  const directory = await resolveJournalDirectory(repoRoot);
  const realRepoRoot = await realpath(repoRoot);
  const journals: StoredJournal[] = [];
  for (const fileName of await listJournalFileNames(directory)) {
    const planId = JOURNAL_FILE_NAME_PATTERN.exec(fileName)?.[1];
    if (planId === undefined) {
      continue;
    }
    const path = join(directory, fileName);
    const journal = await readJournal(path, planId, realRepoRoot);
    if (journal !== null) {
      journals.push({ path, journal });
    }
  }
  return journals;
}

export async function assertNoInterruptedApply(
  repoRoot: string,
): Promise<void> {
  const [interrupted] = await readJournals(repoRoot);
  if (interrupted) {
    throw new Error(
      `An earlier apply (plan ${interrupted.journal.planId}, started ${interrupted.journal.startedAt}) was interrupted. Run 'agemon recover' to restore the files it changed.`,
    );
  }
}
