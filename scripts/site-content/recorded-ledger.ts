import { errorMessage } from "../../src/core/error-message.js";
import {
  type LedgerEntry,
  parseStateManifestContents,
} from "../../src/core/state-manifest.js";
import { isSafeIdentifier } from "../../src/core/untrusted-text.js";
import { SiteContentError } from "./error.js";

export const RECORDED_LEDGER_PATH = "src/data/recorded-ledger.json";
const RE_RECORD_HINT =
  "re-record the website recordings (website/recordings/README.md)";
const MAX_SHOWN_TEXT_LENGTH = 120;

interface RecordedLedgerRow {
  plugin: string;
  type: string;
  firstTarget: string;
  count: number;
}

interface RecordedLedger {
  rows: RecordedLedgerRow[];
  addedPaths: string[];
}

function assertShowable(text: string): void {
  if (!isSafeIdentifier(text)) {
    throw new Error(
      `${JSON.stringify(text)} contains a control, bidi or zero-width character`,
    );
  }
  if (text.length > MAX_SHOWN_TEXT_LENGTH) {
    throw new Error(
      `a ledger value is longer than ${MAX_SHOWN_TEXT_LENGTH} characters`,
    );
  }
}

const RECORDING_RUNS_ROOT = "/work/";

function isAbsoluteTarget(target: string): boolean {
  return target.startsWith("/");
}

function assertInsideRecordingRuns(target: string): void {
  if (
    !target.startsWith(RECORDING_RUNS_ROOT) ||
    target.split("/").includes("..")
  ) {
    throw new Error(
      `the absolute target ${JSON.stringify(target)} is outside the recording's ${RECORDING_RUNS_ROOT}; it may name a path on the recording machine`,
    );
  }
}

function assertRepositoryTarget(target: string): void {
  if (target.startsWith("~") || target.split("/").includes("..")) {
    throw new Error(
      `the target ${JSON.stringify(target)} is not a relative path inside the repository`,
    );
  }
  assertShowable(target);
}

function assertOneAgemonVersion(entries: readonly LedgerEntry[]): void {
  const versions = new Set(entries.map((entry) => entry.agemonVersion));
  const [version] = versions;
  if (versions.size !== 1 || typeof version !== "string") {
    throw new Error("its entries do not share one agemon version");
  }
}

function groupedRows(entries: readonly LedgerEntry[]): RecordedLedgerRow[] {
  const rows = new Map<string, RecordedLedgerRow>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.plugin, entry.type]);
    const row = rows.get(key);
    if (row) row.count += 1;
    else
      rows.set(key, {
        plugin: entry.plugin,
        type: entry.type,
        firstTarget: entry.target,
        count: 1,
      });
  }
  return [...rows.values()];
}

function topLevelPath(target: string): string {
  const [first, ...rest] = target.split("/");
  return rest.length === 0 ? first : `${first}/`;
}

function pathsAgemonOwns(entries: readonly LedgerEntry[]): string[] {
  const owned = entries.filter(
    (entry) => entry.ownershipMode !== null && !entry.preExisting,
  );
  return [...new Set(owned.map((entry) => topLevelPath(entry.target)))];
}

function summarize(rawContents: string): RecordedLedger {
  const { state, migratedFromVersion } =
    parseStateManifestContents(rawContents);
  if (migratedFromVersion !== null) {
    throw new Error(`it uses an older ledger version (${migratedFromVersion})`);
  }
  for (const entry of state.actions) {
    if (isAbsoluteTarget(entry.target)) assertInsideRecordingRuns(entry.target);
  }
  const shownEntries = state.actions.filter(
    (entry) => !isAbsoluteTarget(entry.target),
  );
  if (shownEntries.length === 0) {
    throw new Error("it has no repository entries");
  }
  assertOneAgemonVersion(state.actions);
  for (const entry of shownEntries) {
    assertRepositoryTarget(entry.target);
    assertShowable(entry.plugin);
    assertShowable(entry.type);
  }
  return {
    rows: groupedRows(shownEntries),
    addedPaths: pathsAgemonOwns(shownEntries),
  };
}

export function summarizeRecordedLedger(rawContents: string): RecordedLedger {
  try {
    return summarize(rawContents);
  } catch (error) {
    throw new SiteContentError(
      `${RECORDED_LEDGER_PATH}: ${errorMessage(error)}; ${RE_RECORD_HINT}`,
    );
  }
}
