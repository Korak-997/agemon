import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MANIFEST_RELATIVE_PATH = ".agemon/state.json";
const PRE_MIGRATION_BACKUP_FILE_NAME = "state.v1.bak";
const LEDGER_VERSION = 3;

export type OwnershipMode = "created" | "recorded-key" | "delimited-block";

export interface LedgerBackupRef {
  path: string;
  checksum: string;
}

export interface LedgerValidation {
  ok: boolean;
  detail?: string;
}

export interface LedgerEntry {
  id: string;
  plugin: string;
  type: string;
  target: string;
  preExisting: boolean;
  createdAt: string;
  planId: string | null;
  resourceId: string | null;
  ownershipMode: OwnershipMode | null;
  agemonVersion: string | null;
  fingerprintBefore: string | null;
  fingerprintAfter: string | null;
  desiredRevision: string | null;
  validation: LedgerValidation | null;
  backup: LedgerBackupRef | null;
}

export type ManifestAction = LedgerEntry;

export interface StateManifestData {
  version: typeof LEDGER_VERSION;
  createdAt: string;
  updatedAt: string;
  os: "linux";
  actions: LedgerEntry[];
}

export interface RecordManifestActionInput {
  plugin: string;
  type: string;
  target: string;
  preExisting: boolean;
  planId?: string;
  resourceId?: string;
  ownershipMode?: OwnershipMode;
  agemonVersion?: string;
  fingerprintBefore?: string | null;
  fingerprintAfter?: string | null;
  desiredRevision?: string | null;
  validation?: LedgerValidation | null;
  backup?: LedgerBackupRef | null;
}

export interface LedgerEntryPatch {
  fingerprintBefore?: string | null;
  fingerprintAfter?: string;
  desiredRevision?: string | null;
  validation?: LedgerValidation | null;
}

interface LegacyManifestAction {
  id: string;
  plugin: string;
  type: string;
  target: string;
  preExisting: boolean;
  createdAt: string;
}

function createDefaultState(now: string): StateManifestData {
  return {
    version: LEDGER_VERSION,
    createdAt: now,
    updatedAt: now,
    os: "linux",
    actions: [],
  };
}

function inferOwnershipMode(type: string): OwnershipMode {
  if (type.includes("block")) {
    return "delimited-block";
  }
  if (type.startsWith("preexisting-")) {
    return "recorded-key";
  }
  return "created";
}

function isLegacyManifestAction(value: unknown): value is LegacyManifestAction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Partial<LegacyManifestAction>;
  return (
    typeof typed.id === "string" &&
    typeof typed.plugin === "string" &&
    typeof typed.type === "string" &&
    typeof typed.target === "string" &&
    typeof typed.preExisting === "boolean" &&
    typeof typed.createdAt === "string"
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  return isLegacyManifestAction(value);
}

function normalizeLedgerEntry(value: LedgerEntry): LedgerEntry {
  return {
    id: value.id,
    plugin: value.plugin,
    type: value.type,
    target: value.target,
    preExisting: value.preExisting,
    createdAt: value.createdAt,
    planId: value.planId ?? null,
    resourceId: value.resourceId ?? null,
    ownershipMode: value.ownershipMode ?? null,
    agemonVersion: value.agemonVersion ?? null,
    fingerprintBefore: value.fingerprintBefore ?? null,
    fingerprintAfter: value.fingerprintAfter ?? null,
    desiredRevision: value.desiredRevision ?? null,
    validation: value.validation ?? null,
    backup: value.backup ?? null,
  };
}

function migrateLegacyActionToLedgerEntry(
  action: LegacyManifestAction,
): LedgerEntry {
  return {
    id: action.id,
    plugin: action.plugin,
    type: action.type,
    target: action.target,
    preExisting: action.preExisting,
    createdAt: action.createdAt,
    planId: null,
    resourceId: null,
    ownershipMode: inferOwnershipMode(action.type),
    agemonVersion: null,
    fingerprintBefore: null,
    fingerprintAfter: null,
    desiredRevision: null,
    validation: null,
    backup: null,
  };
}

function hasManifestEnvelope(value: unknown): value is {
  version: unknown;
  createdAt: string;
  updatedAt: string;
  os: "linux";
  actions: unknown[];
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const typed = value as Record<string, unknown>;
  return (
    typed.os === "linux" &&
    typeof typed.createdAt === "string" &&
    typeof typed.updatedAt === "string" &&
    Array.isArray(typed.actions)
  );
}

interface LoadedManifest {
  state: StateManifestData;
  migratedFromVersion: number | null;
}

function interpretManifestContents(parsed: unknown): LoadedManifest {
  if (!hasManifestEnvelope(parsed)) {
    throw new Error("State manifest has an invalid schema");
  }

  if (parsed.version === LEDGER_VERSION || parsed.version === 2) {
    if (!parsed.actions.every((entry) => isLedgerEntry(entry))) {
      throw new Error("State manifest has an invalid schema");
    }
    return {
      state: {
        version: LEDGER_VERSION,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        os: "linux",
        actions: (parsed.actions as LedgerEntry[]).map(normalizeLedgerEntry),
      },
      migratedFromVersion: parsed.version === LEDGER_VERSION ? null : 2,
    };
  }

  if (parsed.version === 1) {
    if (!parsed.actions.every((entry) => isLegacyManifestAction(entry))) {
      throw new Error("State manifest has an invalid schema");
    }
    return {
      state: {
        version: LEDGER_VERSION,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        os: "linux",
        actions: (parsed.actions as LegacyManifestAction[]).map(
          migrateLegacyActionToLedgerEntry,
        ),
      },
      migratedFromVersion: 1,
    };
  }

  throw new Error(
    `Unrecognised state manifest version: ${String(parsed.version)}`,
  );
}

export class StateManifest {
  private recordingAgemonVersion: string | null = null;

  private constructor(
    private readonly manifestPath: string,
    private state: StateManifestData,
  ) {}

  setRecordingAgemonVersion(version: string | null): void {
    this.recordingAgemonVersion = version;
  }

  static async load(cwd: string): Promise<StateManifest> {
    const manifestPath = join(cwd, MANIFEST_RELATIVE_PATH);
    const now = new Date().toISOString();

    let rawContents: string;
    try {
      rawContents = await readFile(manifestPath, "utf8");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return new StateManifest(manifestPath, createDefaultState(now));
      }
      throw new Error(
        `Unable to load manifest at ${manifestPath}: ${String(error)}`,
      );
    }

    const parsed = JSON.parse(rawContents) as unknown;
    const { state, migratedFromVersion } = interpretManifestContents(parsed);
    const manifest = new StateManifest(manifestPath, state);

    if (migratedFromVersion !== null) {
      await manifest.persistPreMigrationBackup(rawContents);
      await manifest.persist();
    }

    return manifest;
  }

  getActions(): LedgerEntry[] {
    return [...this.state.actions];
  }

  hasActions(): boolean {
    return this.state.actions.length > 0;
  }

  hasActionForPlugin(plugin: string): boolean {
    return this.state.actions.some((action) => action.plugin === plugin);
  }

  async recordAction(input: RecordManifestActionInput): Promise<LedgerEntry> {
    const action: LedgerEntry = {
      id: randomUUID(),
      plugin: input.plugin,
      type: input.type,
      target: input.target,
      preExisting: input.preExisting,
      createdAt: new Date().toISOString(),
      planId: input.planId ?? null,
      resourceId: input.resourceId ?? null,
      ownershipMode: input.ownershipMode ?? null,
      agemonVersion: input.agemonVersion ?? this.recordingAgemonVersion,
      fingerprintBefore: input.fingerprintBefore ?? null,
      fingerprintAfter: input.fingerprintAfter ?? null,
      desiredRevision: input.desiredRevision ?? null,
      validation: input.validation ?? null,
      backup: input.backup ?? null,
    };
    this.state.actions.push(action);
    await this.persist();
    return action;
  }

  async updateResourceEntry(
    resourceId: string,
    patch: LedgerEntryPatch,
  ): Promise<LedgerEntry | undefined> {
    const entry = this.state.actions.find(
      (action) => action.resourceId === resourceId,
    );
    if (!entry) {
      return undefined;
    }
    if (patch.fingerprintBefore !== undefined) {
      entry.fingerprintBefore = patch.fingerprintBefore;
    }
    if (patch.fingerprintAfter !== undefined) {
      entry.fingerprintAfter = patch.fingerprintAfter;
    }
    if (patch.desiredRevision !== undefined) {
      entry.desiredRevision = patch.desiredRevision;
    }
    if (patch.validation !== undefined) {
      entry.validation = patch.validation;
    }
    await this.persist();
    return entry;
  }

  async removeActionsForPlugin(plugin: string): Promise<void> {
    const nextActions = this.state.actions.filter(
      (action) => action.plugin !== plugin,
    );
    if (nextActions.length === this.state.actions.length) {
      return;
    }
    this.state.actions = nextActions;
    await this.persist();
  }

  async removeActionsAddedSince(
    knownActionIds: ReadonlySet<string>,
  ): Promise<void> {
    const nextActions = this.state.actions.filter((action) =>
      knownActionIds.has(action.id),
    );
    if (nextActions.length === this.state.actions.length) {
      return;
    }
    this.state.actions = nextActions;
    await this.persist();
  }

  async pruneIfEmpty(): Promise<void> {
    if (this.state.actions.length > 0) {
      return;
    }

    const manifestDir = dirname(this.manifestPath);
    await rm(this.manifestPath, { force: true });
    await rm(manifestDir, { recursive: true, force: true });
  }

  private async persistPreMigrationBackup(rawContents: string): Promise<void> {
    const manifestDir = dirname(this.manifestPath);
    const backupPath = join(manifestDir, PRE_MIGRATION_BACKUP_FILE_NAME);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(backupPath, rawContents, "utf8");
  }

  private async persist(): Promise<void> {
    const now = new Date().toISOString();
    this.state.updatedAt = now;

    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const manifestDir = dirname(this.manifestPath);
    const tempPath = `${this.manifestPath}.tmp-${process.pid}-${Date.now()}`;

    await mkdir(manifestDir, { recursive: true });
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.manifestPath);
  }
}
