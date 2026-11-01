import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  readRegularFileIfExists,
  writeFileAtomic,
  writeNewFileWithFallback,
} from "./files.js";
import { ensureLedgerKey, readLedgerKey } from "./ledger-key.js";
import {
  identitiesAcceptingEntry,
  type ReceiptIdentities,
  repositoryReceiptIdentities,
} from "./machine-ledger.js";
import { resolveStateDirectory } from "./repo-paths.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";
import { isWorkspaceEntry } from "./workspace-footprint.js";

const MANIFEST_RELATIVE_PATH = ".agemon/state.json";
const LEDGER_VERSION = 3;
const RECEIPT_DOMAIN = "agemon-ledger-entry/1";
const RECEIPT_PATTERN = /^[0-9a-f]{64}$/u;

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
  receipt: string | null;
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

const OWNERSHIP_MODES: readonly OwnershipMode[] = [
  "created",
  "recorded-key",
  "delimited-block",
];

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalOwnershipMode(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    OWNERSHIP_MODES.includes(value as OwnershipMode)
  );
}

function isOptionalRecord(
  value: unknown,
  isValidRecord: (record: Record<string, unknown>) => boolean,
): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    isValidRecord(value as Record<string, unknown>)
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isLegacyManifestAction(value)) {
    return false;
  }
  const typed = value as unknown as Record<string, unknown>;
  return (
    isOptionalString(typed.planId) &&
    isOptionalString(typed.resourceId) &&
    isOptionalOwnershipMode(typed.ownershipMode) &&
    isOptionalString(typed.agemonVersion) &&
    isOptionalString(typed.fingerprintBefore) &&
    isOptionalString(typed.fingerprintAfter) &&
    isOptionalString(typed.desiredRevision) &&
    isOptionalRecord(
      typed.validation,
      (validation) =>
        typeof validation.ok === "boolean" &&
        (validation.detail === undefined ||
          typeof validation.detail === "string"),
    ) &&
    isOptionalRecord(
      typed.backup,
      (backup) =>
        typeof backup.path === "string" && typeof backup.checksum === "string",
    )
  );
}

const PATH_TEXT_UNSAFE_CHARACTER_RANGES =
  "\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f";
const PATH_TEXT_UNSAFE_CHARACTERS = new RegExp(
  `[${PATH_TEXT_UNSAFE_CHARACTER_RANGES}]`,
  "u",
);

const MAX_ECHOED_IDENTIFIER_CHARACTERS = 80;

const IDENTIFIER_TEXT_FIELDS = [
  "id",
  "plugin",
  "type",
  "resourceId",
  "planId",
  "createdAt",
  "agemonVersion",
  "fingerprintBefore",
  "fingerprintAfter",
  "desiredRevision",
] as const;

function isSafePathText(value: string): boolean {
  return !PATH_TEXT_UNSAFE_CHARACTERS.test(value);
}

function findUnsafeTextField(entry: Record<string, unknown>): string | null {
  for (const field of IDENTIFIER_TEXT_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && !isSafeIdentifier(value)) {
      return field;
    }
  }
  if (typeof entry.target === "string" && !isSafePathText(entry.target)) {
    return "target";
  }
  const validation = entry.validation as Record<string, unknown> | null;
  if (
    typeof validation?.detail === "string" &&
    !isSafeIdentifier(validation.detail)
  ) {
    return "validation.detail";
  }
  const backup = entry.backup as Record<string, unknown> | null;
  if (typeof backup?.path === "string" && !isSafePathText(backup.path)) {
    return "backup.path";
  }
  if (
    typeof backup?.checksum === "string" &&
    !isSafeIdentifier(backup.checksum)
  ) {
    return "backup.checksum";
  }
  return null;
}

function describeUnsafeEntry(
  entries: unknown[],
): { index: number; field: string; entry: Record<string, unknown> } | null {
  for (const [index, value] of entries.entries()) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const field = findUnsafeTextField(entry);
    if (field !== null) {
      return { index, field, entry };
    }
  }
  return null;
}

function assertSafeLedgerText(entries: unknown[]): void {
  const unsafe = describeUnsafeEntry(entries);
  if (unsafe === null) {
    return;
  }
  const shortText = (value: unknown) =>
    printable(String(value).slice(0, MAX_ECHOED_IDENTIFIER_CHARACTERS));
  throw new Error(
    `${MANIFEST_RELATIVE_PATH} entry ${unsafe.index} (${shortText(unsafe.entry.plugin)}/${shortText(unsafe.entry.id)}): '${unsafe.field}' contains a control character. agemon never writes this — restore .agemon/state.json from git or remove that entry; nuke and apply stay blocked until then.`,
  );
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
    validation: value.validation
      ? {
          ok: value.validation.ok,
          ...(value.validation.detail === undefined
            ? {}
            : { detail: value.validation.detail }),
        }
      : null,
    backup: value.backup
      ? { path: value.backup.path, checksum: value.backup.checksum }
      : null,
    receipt:
      typeof value.receipt === "string" && RECEIPT_PATTERN.test(value.receipt)
        ? value.receipt
        : null,
  };
}

function computeReceipt(
  key: Buffer,
  repositoryIdentity: string,
  entry: LedgerEntry,
): Buffer {
  const { receipt: _unsigned, ...signedFields } = normalizeLedgerEntry(entry);
  return createHmac("sha256", key)
    .update(JSON.stringify([RECEIPT_DOMAIN, repositoryIdentity, signedFields]))
    .digest();
}

function receiptMatches(
  key: Buffer,
  repositoryIdentity: string,
  entry: LedgerEntry,
): boolean {
  return (
    entry.receipt !== null &&
    RECEIPT_PATTERN.test(entry.receipt) &&
    timingSafeEqual(
      Buffer.from(entry.receipt, "hex"),
      computeReceipt(key, repositoryIdentity, entry),
    )
  );
}

function describesSameResource(
  candidate: LedgerEntry,
  recorded: LedgerEntry,
): boolean {
  if (candidate.plugin !== recorded.plugin) {
    return false;
  }
  return recorded.resourceId === null
    ? candidate.resourceId === null &&
        candidate.type === recorded.type &&
        candidate.target === recorded.target
    : candidate.resourceId === recorded.resourceId;
}

export function parseLedgerEntries(value: unknown): LedgerEntry[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => isLedgerEntry(entry)) ||
    describeUnsafeEntry(value) !== null
  ) {
    return null;
  }
  return value.map(normalizeLedgerEntry);
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
    receipt: null,
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

  assertSafeLedgerText(parsed.actions);
  if (parsed.version === LEDGER_VERSION || parsed.version === 2) {
    const actions = parseLedgerEntries(parsed.actions);
    if (actions === null) {
      throw new Error("State manifest has an invalid schema");
    }
    return {
      state: {
        version: LEDGER_VERSION,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        os: "linux",
        actions,
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

function parseManifestJson(rawContents: string): unknown {
  try {
    return JSON.parse(rawContents);
  } catch (error) {
    throw new Error(
      `${MANIFEST_RELATIVE_PATH} is not valid JSON (${printable((error as Error).message)}). ` +
        "It was left untouched. Fix it, or move it aside to start with an empty " +
        "ledger (agemon then forgets what it installed in this repo).",
    );
  }
}

export function parseStateManifestContents(
  rawContents: string,
): LoadedManifest {
  return interpretManifestContents(parseManifestJson(rawContents));
}

export class StateManifest {
  private recordingAgemonVersion: string | null = null;
  private recordingPlanId: string | null = null;
  private receiptKey: Buffer | null = null;
  private receiptIdentities: ReceiptIdentities | null = null;

  private constructor(
    private readonly repoRoot: string,
    private readonly manifestPath: string,
    private state: StateManifestData,
  ) {}

  private async loadReceiptContext(): Promise<void> {
    this.receiptKey = await readLedgerKey();
    this.receiptIdentities = await repositoryReceiptIdentities(this.repoRoot);
  }

  private async signingContext(): Promise<{ key: Buffer; identity: string }> {
    await resolveStateDirectory(this.repoRoot, [], { create: true });
    this.receiptIdentities ??= await repositoryReceiptIdentities(this.repoRoot);
    this.receiptKey ??= await ensureLedgerKey();
    this.resignPathFormEntries(this.receiptKey, this.receiptIdentities);
    return { key: this.receiptKey, identity: this.receiptIdentities.signing };
  }

  private resignPathFormEntries(
    key: Buffer,
    { signing, byPath }: ReceiptIdentities,
  ): void {
    if (signing === byPath) {
      return;
    }
    for (const entry of this.state.actions) {
      if (this.isConfirmed(entry) && !receiptMatches(key, signing, entry)) {
        entry.receipt = computeReceipt(key, signing, entry).toString("hex");
      }
    }
  }

  isConfirmed(entry: LedgerEntry): boolean {
    const key = this.receiptKey;
    if (key === null || this.receiptIdentities === null) {
      return false;
    }
    return identitiesAcceptingEntry(
      this.receiptIdentities,
      entry.createdAt,
    ).some((identity) => receiptMatches(key, identity, entry));
  }

  getConfirmedActions(): LedgerEntry[] {
    return this.state.actions.filter((action) => this.isConfirmed(action));
  }

  setRecordingAgemonVersion(version: string | null): void {
    this.recordingAgemonVersion = version;
  }

  setRecordingPlanId(planId: string | null): void {
    this.recordingPlanId = planId;
  }

  static async load(cwd: string): Promise<StateManifest> {
    const manifestPath = join(cwd, MANIFEST_RELATIVE_PATH);
    const now = new Date().toISOString();

    const stateDirectory = await resolveStateDirectory(cwd, [], {
      create: false,
    });
    let rawContents: string | null;
    try {
      rawContents =
        stateDirectory === null
          ? null
          : await readRegularFileIfExists(manifestPath);
    } catch (error) {
      throw new Error(
        `Unable to load manifest at ${manifestPath}: ${String(error)}`,
      );
    }
    if (rawContents === null) {
      return new StateManifest(cwd, manifestPath, createDefaultState(now));
    }

    const { state, migratedFromVersion } =
      parseStateManifestContents(rawContents);
    const manifest = new StateManifest(cwd, manifestPath, state);
    if (state.actions.length > 0) {
      await manifest.loadReceiptContext();
    }

    if (migratedFromVersion !== null) {
      await manifest.persistPreMigrationBackup(
        rawContents,
        migratedFromVersion,
      );
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

  hasCapabilityActions(): boolean {
    return this.state.actions.some((action) => !isWorkspaceEntry(action));
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
      planId: input.planId ?? this.recordingPlanId,
      resourceId: input.resourceId ?? null,
      ownershipMode: input.ownershipMode ?? null,
      agemonVersion: input.agemonVersion ?? this.recordingAgemonVersion,
      fingerprintBefore: input.fingerprintBefore ?? null,
      fingerprintAfter: input.fingerprintAfter ?? null,
      desiredRevision: input.desiredRevision ?? null,
      validation: input.validation ?? null,
      backup: input.backup ?? null,
      receipt: null,
    };
    assertSafeLedgerText([action]);
    const { key, identity } = await this.signingContext();
    action.receipt = computeReceipt(key, identity, action).toString("hex");
    this.state.actions = this.state.actions.filter(
      (existing) =>
        this.isConfirmed(existing) || !describesSameResource(existing, action),
    );
    this.state.actions.push(action);
    await this.persist();
    return action;
  }

  async updateResourceEntry(
    resourceId: string,
    patch: LedgerEntryPatch,
  ): Promise<LedgerEntry | undefined> {
    const entriesForResource = this.state.actions.filter(
      (action) => action.resourceId === resourceId,
    );
    const entry =
      entriesForResource.find((action) => this.isConfirmed(action)) ??
      entriesForResource[0];
    if (!entry) {
      return undefined;
    }
    const wasConfirmed = this.isConfirmed(entry);
    assertSafeLedgerText([
      {
        ...entry,
        ...Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        ),
      },
    ]);
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
    entry.receipt = null;
    if (wasConfirmed) {
      const { key, identity } = await this.signingContext();
      entry.receipt = computeReceipt(key, identity, entry).toString("hex");
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

  async removeActionIds(ids: readonly string[]): Promise<void> {
    const removedIds = new Set(ids);
    const nextActions = this.state.actions.filter(
      (action) => !removedIds.has(action.id),
    );
    if (nextActions.length === this.state.actions.length) {
      return;
    }
    this.state.actions = nextActions;
    await this.persist();
  }

  async restoreActions(entries: LedgerEntry[]): Promise<void> {
    const restoredActions = entries.map(normalizeLedgerEntry);
    if (
      JSON.stringify(restoredActions) === JSON.stringify(this.state.actions)
    ) {
      return;
    }
    this.state.actions = restoredActions;
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

  private async persistPreMigrationBackup(
    rawContents: string,
    fromVersion: number,
  ): Promise<void> {
    const manifestDir = dirname(this.manifestPath);
    await resolveStateDirectory(this.repoRoot, [], { create: true });
    await writeNewFileWithFallback(
      join(manifestDir, `state.v${fromVersion}.bak`),
      join(manifestDir, `state.v${fromVersion}.${Date.now()}.bak`),
      rawContents,
    );
  }

  private async persist(): Promise<void> {
    const now = new Date().toISOString();
    this.state.updatedAt = now;

    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    await resolveStateDirectory(this.repoRoot, [], { create: true });
    await writeFileAtomic(this.manifestPath, payload);
  }
}
