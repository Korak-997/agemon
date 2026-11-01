import { realpath } from "node:fs/promises";
import type { Context } from "../core/context.js";
import {
  directoryIdentity,
  isRecordableRepositoryPath,
  MAX_SHARED_RESOURCE_HOLDERS,
  readMachineLedger,
  type SharedResourceRecord,
  updateSharedResource,
  withoutMissingHolders,
  withoutReplacedOwner,
} from "../core/machine-ledger.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import { printable } from "../core/untrusted-text.js";
import { describeOperation } from "./proposed-operation.js";
import type {
  AgemonPlugin,
  ProposedOperation,
  SharedResourceDeclaration,
} from "./types.js";

const ACTION_TYPE_USES_SHARED_RESOURCE = "uses-shared-resource";
const SHARED_RESOURCE_ENTRY_PREFIX = "shared:";
const INSTALL_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "installed-binary",
  "installed-cli-tool",
]);

interface SharedResourceProbe {
  isPresent(): Promise<boolean>;
}

interface ThisRepository {
  path: string;
  directoryId: string;
}

type ReleaseDecision =
  | { kind: "not-registered" }
  | { kind: "still-used"; others: string[] }
  | { kind: "not-the-installer" }
  | { kind: "installer-entry-unconfirmed" }
  | { kind: "needs-remove-shared"; claimedBy: string }
  | { kind: "remove"; claimedBy: string | null };

async function resolveThisRepository(ctx: Context): Promise<ThisRepository> {
  const path = await realpath(ctx.cwd);
  if (!isRecordableRepositoryPath(path)) {
    throw new Error(
      `This repository's path ${printable(path)} contains control characters, so agemon can't record it as a user of shared tools. Move it to a plain path and run agemon again.`,
    );
  }
  const directoryId = await directoryIdentity(path);
  if (directoryId === null) {
    throw new Error(
      `Can't read this repository's directory ${printable(path)}; run agemon again from an existing repository.`,
    );
  }
  return { path, directoryId };
}

function reportPrunedHolder(
  ctx: Context,
  resource: SharedResourceDeclaration,
): (holder: string) => void {
  return (holder) =>
    ctx.ui.info(
      `dropped ${printable(holder)} as a user of ${resource.toolName}: it no longer exists`,
    );
}

function sharedResourceEntryId(resource: SharedResourceDeclaration): string {
  return `${SHARED_RESOURCE_ENTRY_PREFIX}${resource.id}`;
}

export async function isHeldByThisRepository(
  ctx: Context,
  resource: SharedResourceDeclaration,
): Promise<boolean> {
  const record = (await readMachineLedger()).resources[resource.id];
  return record?.holders.includes(await realpath(ctx.cwd)) ?? false;
}

export async function wasInstalledByAgemon(
  resource: SharedResourceDeclaration,
  repoLedgerSaysInstalled: boolean,
): Promise<boolean> {
  if (repoLedgerSaysInstalled) {
    return true;
  }
  const origin = (await readMachineLedger()).resources[resource.id]?.origin;
  return origin === "installed" || origin === "migrated";
}

export function describeUseSharedOperation(
  capabilityId: string,
  resource: SharedResourceDeclaration,
  repoLedgerSaysInstalled: boolean,
): ProposedOperation {
  const claim = repoLedgerSaysInstalled
    ? " (this repository's ledger says agemon installed it)"
    : "";
  return describeOperation({
    capabilityId,
    resourceId: resource.id,
    targetPath: resource.id,
    action: "use-shared",
    riskClass: "inert",
    requiresConsent: false,
    preview: {
      kind: "note",
      text: `record that this repository uses ${resource.toolName}${claim}`,
    },
  });
}

async function recordUsesSharedResource(
  ctx: Context,
  capabilityId: string,
  resource: SharedResourceDeclaration,
): Promise<void> {
  const entryResourceId = sharedResourceEntryId(resource);
  const alreadyRecorded = ctx.manifest
    .getActions()
    .some(
      (entry) =>
        entry.plugin === capabilityId &&
        entry.type === ACTION_TYPE_USES_SHARED_RESOURCE &&
        entry.resourceId === entryResourceId,
    );
  if (alreadyRecorded) {
    return;
  }
  await ctx.manifest.recordAction({
    plugin: capabilityId,
    type: ACTION_TYPE_USES_SHARED_RESOURCE,
    target: resource.toolName,
    resourceId: entryResourceId,
    preExisting: true,
  });
}

function assertRoomForHolder(
  resource: SharedResourceDeclaration,
  record: SharedResourceRecord | null,
  repository: ThisRepository,
): void {
  if (
    record !== null &&
    !record.holders.includes(repository.path) &&
    record.holders.length >= MAX_SHARED_RESOURCE_HOLDERS
  ) {
    throw new Error(
      `${resource.toolName} already has ${MAX_SHARED_RESOURCE_HOLDERS} repositories recorded as users, so agemon can't add this one. Run 'agemon nuke' in repositories you no longer use (see 'agemon status'), then run agemon here again.`,
    );
  }
}

function withHolder(holders: string[], repository: string): string[] {
  return holders.includes(repository) ? holders : [...holders, repository];
}

function installedRecord(
  record: SharedResourceRecord | null,
  repository: ThisRepository,
): SharedResourceRecord {
  return {
    origin: "installed",
    installedBy: repository.path,
    ownerDirectoryId: repository.directoryId,
    holders: withHolder(record?.holders ?? [], repository.path),
  };
}

function holdExistingResource(
  resource: SharedResourceDeclaration,
  record: SharedResourceRecord | null,
  repository: ThisRepository,
  repoLedgerSaysInstalled: boolean,
): SharedResourceRecord {
  if (record !== null) {
    return { ...record, holders: withHolder(record.holders, repository.path) };
  }
  return repoLedgerSaysInstalled && resource.migratesFromRepoLedgers
    ? {
        origin: "migrated",
        claimedBy: repository.path,
        ownerDirectoryId: repository.directoryId,
        holders: [repository.path],
      }
    : { origin: "pre-existing", holders: [repository.path] };
}

export async function addSharedHolder(
  ctx: Context,
  capabilityId: string,
  resource: SharedResourceDeclaration,
  options: SharedResourceProbe & { repoLedgerSaysInstalled: boolean },
): Promise<void> {
  const repository = await resolveThisRepository(ctx);
  await updateSharedResource(
    resource.id,
    async (record) => {
      if (!(await options.isPresent())) {
        throw new Error(
          `${resource.toolName} is no longer installed — re-run 'agemon plan'.`,
        );
      }
      assertRoomForHolder(resource, record, repository);
      await recordUsesSharedResource(ctx, capabilityId, resource);
      return {
        record: holdExistingResource(
          resource,
          record,
          repository,
          options.repoLedgerSaysInstalled,
        ),
        result: undefined,
      };
    },
    reportPrunedHolder(ctx, resource),
  );
}

export async function createSharedResource(
  ctx: Context,
  capabilityId: string,
  resource: SharedResourceDeclaration,
  options: SharedResourceProbe & {
    create(): Promise<void>;
    recordInstall(): Promise<void>;
  },
): Promise<"created" | "already-present"> {
  const repository = await resolveThisRepository(ctx);
  return updateSharedResource(
    resource.id,
    async (record, lock) => {
      assertRoomForHolder(resource, record, repository);
      if (await options.isPresent()) {
        ctx.ui.info(`${resource.toolName} was installed meanwhile — using it`);
        await recordUsesSharedResource(ctx, capabilityId, resource);
        return {
          record: holdExistingResource(resource, record, repository, false),
          result: "already-present" as const,
        };
      }
      await lock.assertStillHeld();
      await options.create();
      await options.recordInstall();
      return {
        record: installedRecord(record, repository),
        result: "created" as const,
      };
    },
    reportPrunedHolder(ctx, resource),
  );
}

export async function claimSharedResourceBeforeCreating(
  ctx: Context,
  resource: SharedResourceDeclaration,
  options: SharedResourceProbe & {
    recordIntent(becomesInstaller: boolean): Promise<void>;
  },
): Promise<boolean> {
  const repository = await resolveThisRepository(ctx);
  return updateSharedResource(
    resource.id,
    async (record) => {
      assertRoomForHolder(resource, record, repository);
      const anotherInstallerStillHoldsIt =
        record?.origin === "installed" &&
        record.installedBy !== repository.path &&
        record.holders.includes(record.installedBy);
      const mustCreate = !(await options.isPresent());
      const becomesInstaller = mustCreate && !anotherInstallerStillHoldsIt;
      await options.recordIntent(becomesInstaller);
      return {
        record: becomesInstaller
          ? installedRecord(record, repository)
          : holdExistingResource(resource, record, repository, false),
        result: mustCreate,
      };
    },
    reportPrunedHolder(ctx, resource),
  );
}

function recordedInstaller(record: SharedResourceRecord): string | null {
  switch (record.origin) {
    case "installed":
      return record.installedBy;
    case "migrated":
      return record.claimedBy;
    case "pre-existing":
      return null;
  }
}

function decideRelease(
  record: SharedResourceRecord | null,
  repository: string,
  releasingRepoInstalledIt: boolean,
  removeSharedRequested: boolean,
): ReleaseDecision {
  if (record === null || !record.holders.includes(repository)) {
    return { kind: "not-registered" };
  }
  const others = record.holders.filter((holder) => holder !== repository);
  if (others.length > 0) {
    return { kind: "still-used", others };
  }
  if (!releasingRepoInstalledIt) {
    return recordedInstaller(record) === repository
      ? { kind: "installer-entry-unconfirmed" }
      : { kind: "not-the-installer" };
  }
  if (record.origin === "installed" && record.installedBy === repository) {
    return { kind: "remove", claimedBy: null };
  }
  if (record.origin === "migrated" && record.claimedBy === repository) {
    return removeSharedRequested
      ? { kind: "remove", claimedBy: record.claimedBy }
      : { kind: "needs-remove-shared", claimedBy: record.claimedBy };
  }
  return { kind: "not-the-installer" };
}

function recordAfterRelease(
  decision: ReleaseDecision,
  record: SharedResourceRecord | null,
): SharedResourceRecord | null {
  if (decision.kind === "not-registered") {
    return record;
  }
  if (decision.kind === "still-used" && record !== null) {
    return { ...record, holders: decision.others };
  }
  return null;
}

function describeRemoval(
  resource: SharedResourceDeclaration,
  decision: Extract<ReleaseDecision, { kind: "remove" }>,
): string {
  return decision.claimedBy === null
    ? `Would ${resource.removalVerb} ${resource.toolName} (no other repository uses it)`
    : `Would ${resource.removalVerb} ${resource.toolName} (no other repository uses it; installed before agemon tracked shared tools — the ledger of ${printable(decision.claimedBy)} says agemon installed it)`;
}

const REMOVAL_PAST_TENSE: Record<
  SharedResourceDeclaration["removalVerb"],
  string
> = {
  uninstall: "uninstalled",
  disable: "disabled",
};

async function isPresentOrUnknown(
  probe: SharedResourceProbe,
): Promise<boolean> {
  try {
    return await probe.isPresent();
  } catch {
    return true;
  }
}

async function unregisteredResourceMayNeedRemoval(
  decision: Exclude<ReleaseDecision, { kind: "remove" }>,
  options: SharedResourceProbe & { releasingRepoInstalledIt: boolean },
): Promise<boolean> {
  return (
    decision.kind === "not-registered" &&
    options.releasingRepoInstalledIt &&
    (await isPresentOrUnknown(options))
  );
}

function describeKeptResource(
  ctx: Context,
  resource: SharedResourceDeclaration,
  decision: Exclude<ReleaseDecision, { kind: "remove" }>,
  record: SharedResourceRecord | null,
  unregisteredResourceMayNeedRemoval: boolean,
): string {
  const keeping = `${ctx.dryRun ? "Would keep" : "Keeping"} ${resource.toolName}`;
  const manualRemoval = `run '${resource.manualRemoveCommand}' yourself if nothing else needs it`;
  switch (decision.kind) {
    case "not-registered":
      return unregisteredResourceMayNeedRemoval
        ? `${keeping}: this repository is not registered as using it — ${manualRemoval}`
        : `${keeping}: this repository is not registered as using it`;
    case "still-used":
      return `${keeping}: still used by ${decision.others.map(printable).join(", ")}`;
    case "not-the-installer":
      return record?.origin === "pre-existing" &&
        resource.removalVerb === "disable"
        ? `${keeping}: it was enabled before agemon tracked it — ${manualRemoval}`
        : `${keeping}: agemon has no record on this machine that it installed it from this repository — ${manualRemoval}`;
    case "installer-entry-unconfirmed":
      return `${keeping}: the shared-tools ledger names this repository as its installer, but this repository's ledger entry for that install is not confirmed (written before ledger receipts, or not on this machine) — ${manualRemoval}`;
    case "needs-remove-shared": {
      const reason = `${keeping}: agemon installed it before it tracked shared tools (the ledger of ${printable(decision.claimedBy)} says so), so another repository may still use it.`;
      return ctx.dryRun
        ? `${reason} Re-run with --remove-shared ${resource.toolName}, or run '${resource.manualRemoveCommand}'.`
        : `${reason} Run '${resource.manualRemoveCommand}' yourself if nothing else needs it.`;
    }
  }
}

export function repoLedgerUsesSharedResource(
  entries: LedgerEntry[],
  resource: SharedResourceDeclaration,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === ACTION_TYPE_USES_SHARED_RESOURCE &&
      entry.resourceId === sharedResourceEntryId(resource),
  );
}

async function currentRecord(
  resource: SharedResourceDeclaration,
): Promise<SharedResourceRecord | null> {
  const stored = (await readMachineLedger()).resources[resource.id] ?? null;
  return stored === null
    ? null
    : withoutReplacedOwner({
        ...stored,
        holders: await withoutMissingHolders(stored.holders, () => {}),
      });
}

export async function releaseSharedResource(
  ctx: Context,
  resource: SharedResourceDeclaration,
  options: SharedResourceProbe & {
    releasingRepoInstalledIt: boolean;
    remove(): Promise<void>;
  },
): Promise<void> {
  const repository = await realpath(ctx.cwd);
  const removeSharedRequested =
    ctx.removeSharedTools?.has(resource.toolName) ?? false;

  if (ctx.dryRun) {
    const record = await currentRecord(resource);
    const decision = decideRelease(
      record,
      repository,
      options.releasingRepoInstalledIt,
      removeSharedRequested,
    );
    ctx.ui.info(
      decision.kind === "remove"
        ? describeRemoval(resource, decision)
        : describeKeptResource(
            ctx,
            resource,
            decision,
            record,
            await unregisteredResourceMayNeedRemoval(decision, options),
          ),
    );
    return;
  }

  await updateSharedResource(
    resource.id,
    async (record, lock) => {
      const decision = decideRelease(
        record,
        repository,
        options.releasingRepoInstalledIt,
        removeSharedRequested,
      );
      if (decision.kind !== "remove") {
        ctx.ui.info(
          describeKeptResource(
            ctx,
            resource,
            decision,
            record,
            await unregisteredResourceMayNeedRemoval(decision, options),
          ),
        );
      } else if (await options.isPresent()) {
        await lock.assertStillHeld();
        await options.remove();
      } else {
        ctx.ui.info(
          `${resource.toolName} was already ${REMOVAL_PAST_TENSE[resource.removalVerb]}`,
        );
      }
      return {
        record: recordAfterRelease(decision, record),
        result: undefined,
      };
    },
    reportPrunedHolder(ctx, resource),
  );
}

export interface SharedToolStatus {
  tool: string;
  origin: SharedResourceRecord["origin"];
  recordedBy: string | null;
  holders: { path: string; thisRepository: boolean; missing: boolean }[];
  heldWithoutLedgerEntry: boolean;
  manualRemoveCommand: string;
}

function ledgerRecordsUseOf(
  ctx: Context,
  plugin: AgemonPlugin,
  resource: SharedResourceDeclaration,
): boolean {
  const entries = ctx.manifest
    .getActions()
    .filter((entry) => entry.plugin === plugin.id);
  return (
    repoLedgerUsesSharedResource(entries, resource) ||
    entries.some((entry) => INSTALL_ENTRY_TYPES.has(entry.type))
  );
}

export async function describeSharedTools(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<SharedToolStatus[]> {
  const ledger = await readMachineLedger();
  const repository = await realpath(ctx.cwd);
  const rows: SharedToolStatus[] = [];
  for (const plugin of plugins) {
    for (const resource of plugin.sharedResources ?? []) {
      const stored = ledger.resources[resource.id];
      if (stored === undefined) {
        continue;
      }
      const record = await withoutReplacedOwner(stored);
      const existing = new Set(
        await withoutMissingHolders(record.holders, () => {}),
      );
      rows.push({
        tool: resource.toolName,
        origin: record.origin,
        recordedBy: recordedInstaller(record),
        holders: record.holders.map((holder) => ({
          path: holder,
          thisRepository: holder === repository,
          missing: !existing.has(holder),
        })),
        heldWithoutLedgerEntry:
          record.holders.includes(repository) &&
          !ledgerRecordsUseOf(ctx, plugin, resource),
        manualRemoveCommand: resource.manualRemoveCommand,
      });
    }
  }
  return rows;
}
