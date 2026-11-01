import { opendir, readFile, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  immutableBackupCandidates,
  readFirstExistingBackup,
  replaceStaleBackup,
  resolveImmutableBackupPath,
} from "../../core/backups.js";
import { AGENT_FILE_RESOURCE_PREFIX } from "../../core/consent.js";
import type { Context } from "../../core/context.js";
import {
  MAX_READ_FILE_LABEL,
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "../../core/files.js";
import { fingerprintContent } from "../../core/fingerprint.js";
import { revertManagedFile } from "../../core/managed-file-revert.js";
import {
  readRegularFilePrefix,
  resolveInsideRepo,
  resolveRepoDirectory,
} from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { isSafeIdentifier, printable } from "../../core/untrusted-text.js";
import { describeOperation } from "../proposed-operation.js";
import {
  type AgentDefinition,
  RETIRED_AGENT_NAMES,
  SKILL_GROUPS,
  type SkillGroup,
} from "../skills/catalog.js";
import {
  builtInGroupIdFromResource,
  recordedBuiltInGroupIds,
  SKILLS_PLUGIN_ID,
} from "../skills/ledger-view.js";
import type {
  AgemonPlugin,
  CapabilityState,
  CapabilityStateRow,
  PluginApplyReport,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  ProposedOperationAction,
  SkippedPluginOperation,
  StagedFile,
} from "../types.js";

const PLUGIN_ID = "agents";
const AGENTS_DIRECTORY = ".claude/agents";
const AGENT_TARGET_PATTERN =
  /^\.claude\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
const ACTION_TYPE_MANAGED_AGENT_FILE = "managed-agent-file";
const ACTION_TYPE_ADOPTED_AGENT_FILE = "adopted-agent-file";
const AGENT_FILE_ACTIONS: readonly ProposedOperationAction[] = [
  "create",
  "replace",
  "adopt",
  "conflict",
];
const MAX_AGENT_DIRECTORY_ENTRIES = 256;
const AGENT_FRONTMATTER_PREFIX_BYTES = 4096;
const AGENT_FRONTMATTER_MAX_LINES = 64;
const BYTE_ORDER_MARK = "﻿";
const FRONTMATTER_FENCE = "---";
const NAME_KEY = "name";
const UPDATE_AVAILABLE_DETAIL =
  "agemon has a newer version; run agemon to update it";
const CLAIM_SUFFIX = " (ledger entry not written by agemon on this machine)";

interface CatalogAgent {
  group: SkillGroup;
  agent: AgentDefinition;
}

type AgentFileState =
  | { kind: "not-a-regular-file" }
  | { kind: "readable"; contents: string | null };

function catalogAgents(): CatalogAgent[] {
  return SKILL_GROUPS.flatMap((group) =>
    (group.agents ?? []).map((agent) => ({ group, agent })),
  );
}

function agentTarget(name: string): string {
  return `${AGENTS_DIRECTORY}/${name}.md`;
}

function agentResourceId(name: string): string {
  return `${AGENT_FILE_RESOURCE_PREFIX}${name}`;
}

function catalogAgentForTarget(target: string): CatalogAgent | undefined {
  const name = AGENT_TARGET_PATTERN.exec(target)?.[1];
  return catalogAgents().find((entry) => entry.agent.name === name);
}

function retiredAgentNameForTarget(target: string): string | undefined {
  const name = AGENT_TARGET_PATTERN.exec(target)?.[1];
  return RETIRED_AGENT_NAMES.find((retiredName) => retiredName === name);
}

function revertableAgentName(target: string): string | undefined {
  return (
    catalogAgentForTarget(target)?.agent.name ??
    retiredAgentNameForTarget(target)
  );
}

export async function renderAgentFile(agent: AgentDefinition): Promise<string> {
  const frontmatter = [
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    `tools: ${agent.tools.join(", ")}`,
  ].join("\n");
  const brief = await readFile(agent.briefPath, "utf8");
  return `---\n${frontmatter}\n---\n\n${brief}`;
}

function pluginActions(ctx: Context): LedgerEntry[] {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function confirmedPluginActions(ctx: Context): LedgerEntry[] {
  return pluginActions(ctx).filter((action) =>
    ctx.manifest.isConfirmed(action),
  );
}

function ledgerEntryForTarget(
  ctx: Context,
  target: string,
): LedgerEntry | undefined {
  return confirmedPluginActions(ctx).find((action) => action.target === target);
}

function assertAgentsPerforms(operation: ProposedOperation): CatalogAgent {
  const entry = catalogAgentForTarget(operation.targetPath);
  if (
    entry === undefined ||
    operation.resourceId !== agentResourceId(entry.agent.name) ||
    operation.targetPath !== agentTarget(entry.agent.name) ||
    !AGENT_FILE_ACTIONS.includes(operation.action)
  ) {
    throw new Error(
      `Plan operation ${printable(operation.id)} is not something the agents capability does (${operation.action} ${printable(operation.targetPath)}).`,
    );
  }
  return entry;
}

function plannedGroupIds(
  plannedSoFar: readonly ProposedOperation[],
): Set<string> {
  const groupIds = new Set<string>();
  for (const operation of plannedSoFar) {
    const groupId =
      operation.capabilityId === SKILLS_PLUGIN_ID &&
      operation.action === "install-package"
        ? builtInGroupIdFromResource(operation.resourceId)
        : null;
    if (groupId !== null) {
      groupIds.add(groupId);
    }
  }
  return groupIds;
}

function desiredAgents(
  ctx: Context,
  plannedSoFar: readonly ProposedOperation[],
): CatalogAgent[] {
  const groupIds = new Set([
    ...plannedGroupIds(plannedSoFar),
    ...recordedBuiltInGroupIds(ctx),
  ]);
  return catalogAgents().filter(({ group }) => groupIds.has(group.id));
}

async function readAgentFile(
  ctx: Context,
  target: string,
): Promise<AgentFileState> {
  try {
    return {
      kind: "readable",
      contents: await readRegularFileIfExists(
        await resolveInsideRepo(ctx.cwd, target),
      ),
    };
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return { kind: "not-a-regular-file" };
    }
    throw error;
  }
}

function agentOperation(
  name: string,
  action: ProposedOperationAction,
  expectedFingerprint: string | null,
  preview: ProposedOperation["preview"],
): ProposedOperation {
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: agentResourceId(name),
    targetPath: agentTarget(name),
    action,
    riskClass: "writes-config",
    requiresConsent: true,
    expectedFingerprint,
    preview,
  });
}

async function planAgent(
  ctx: Context,
  { agent }: CatalogAgent,
): Promise<ProposedOperation | null> {
  const target = agentTarget(agent.name);
  const file = await readAgentFile(ctx, target);
  if (file.kind === "not-a-regular-file") {
    return agentOperation(agent.name, "conflict", null, {
      kind: "note",
      text: `${target} is a symlink, special file, larger than ${MAX_READ_FILE_LABEL}, or under a symlinked directory; agemon leaves it alone.`,
    });
  }

  const desired = await renderAgentFile(agent);
  const { contents } = file;
  const diffPreview = {
    kind: "diff" as const,
    text: renderUnifiedDiff(contents ?? "", desired, target),
  };
  if (contents === null) {
    return agentOperation(agent.name, "create", null, diffPreview);
  }

  const fingerprint = fingerprintContent(contents);
  const recorded = ledgerEntryForTarget(ctx, target);
  if (contents === desired) {
    return recorded
      ? null
      : agentOperation(agent.name, "adopt", fingerprint, {
          kind: "note",
          text: `${target} already matches agemon's ${agent.name}; record the adoption in the ledger and write nothing.`,
        });
  }
  const untouchedSinceRecorded = recorded?.fingerprintAfter === fingerprint;
  return agentOperation(
    agent.name,
    untouchedSinceRecorded ? "replace" : "conflict",
    fingerprint,
    diffPreview,
  );
}

async function planAgents(
  ctx: Context,
  plannedSoFar: readonly ProposedOperation[] = [],
): Promise<ProposedOperation[]> {
  const operations: ProposedOperation[] = [];
  for (const entry of desiredAgents(ctx, plannedSoFar)) {
    const operation = await planAgent(ctx, entry);
    if (operation) {
      operations.push(operation);
    }
  }
  return operations;
}

async function materializeAgents(
  _ctx: Context,
  operations: ProposedOperation[],
): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  for (const operation of operations) {
    const { agent } = assertAgentsPerforms(operation);
    if (operation.action === "create" || operation.action === "replace") {
      staged.push({
        targetPath: operation.targetPath,
        contents: await renderAgentFile(agent),
        kind: "markdown",
      });
    }
  }
  return staged;
}

async function recordAdoption(
  ctx: Context,
  target: string,
  name: string,
  contents: string | null,
): Promise<void> {
  const fingerprint = contents === null ? null : fingerprintContent(contents);
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_ADOPTED_AGENT_FILE,
    target,
    preExisting: true,
    resourceId: agentResourceId(name),
    ownershipMode: "recorded-key",
    fingerprintBefore: fingerprint,
    fingerprintAfter: fingerprint,
    backup: null,
  });
}

async function differentEarlierOriginalPath(
  ctx: Context,
  name: string,
  contentsBefore: string,
): Promise<string | null> {
  const earlier = await readFirstExistingBackup(ctx.cwd, [
    resolveImmutableBackupPath(ctx.cwd, agentResourceId(name)),
  ]);
  return earlier !== null && earlier.contents !== contentsBefore
    ? earlier.path
    : null;
}

async function writeAgentFile(
  ctx: Context,
  operation: ProposedOperation,
  name: string,
  contentsAfter: string,
): Promise<{ skipReason: string } | null> {
  const target = operation.targetPath;
  await resolveRepoDirectory(ctx.cwd, AGENTS_DIRECTORY, { create: true });
  const targetPath = await resolveInsideRepo(ctx.cwd, target);
  const contentsBefore = await readRegularFileIfExists(targetPath);
  const recorded = ledgerEntryForTarget(ctx, target);
  const keepsRecordedOriginal =
    recorded?.type === ACTION_TYPE_MANAGED_AGENT_FILE &&
    (contentsBefore === null ||
      fingerprintContent(contentsBefore) === recorded.fingerprintAfter);

  if (keepsRecordedOriginal) {
    await writeFileAtomic(targetPath, contentsAfter);
    await ctx.manifest.updateResourceEntry(agentResourceId(name), {
      fingerprintAfter: fingerprintContent(contentsAfter),
    });
    return null;
  }

  const earlierOriginalPath =
    contentsBefore === null
      ? null
      : await differentEarlierOriginalPath(ctx, name, contentsBefore);
  if (earlierOriginalPath !== null) {
    return {
      skipReason: `agemon already keeps an earlier original of it at ${relative(ctx.cwd, earlierOriginalPath)}; keep your version, or delete ${target} and re-run agemon`,
    };
  }

  const backup =
    contentsBefore === null
      ? null
      : await replaceStaleBackup(
          ctx.cwd,
          agentResourceId(name),
          contentsBefore,
        );
  await writeFileAtomic(targetPath, contentsAfter);
  if (recorded) {
    await ctx.manifest.removeActionIds([recorded.id]);
  }
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_MANAGED_AGENT_FILE,
    target,
    preExisting: contentsBefore !== null,
    resourceId: agentResourceId(name),
    ownershipMode: "created",
    fingerprintBefore:
      contentsBefore === null ? null : fingerprintContent(contentsBefore),
    fingerprintAfter: fingerprintContent(contentsAfter),
    backup:
      backup === null ? null : { path: backup.path, checksum: backup.checksum },
  });
  return null;
}

async function applyAgents(
  ctx: Context,
  operations: ProposedOperation[],
  staged?: StagedFile[],
): Promise<PluginApplyReport> {
  const stagedContentsByPath = new Map(
    (staged ?? []).map((file) => [file.targetPath, file.contents] as const),
  );
  const installedGroupIds = recordedBuiltInGroupIds(ctx);
  const skipped: SkippedPluginOperation[] = [];
  for (const operation of operations) {
    const { group, agent } = assertAgentsPerforms(operation);
    if (operation.action === "conflict") {
      continue;
    }
    if (!installedGroupIds.has(group.id)) {
      skipped.push({
        operationId: operation.id,
        reason: `its skill group ${group.id} is not installed; approve the skill group install to get it`,
      });
      continue;
    }
    if (operation.action === "adopt") {
      if (!ledgerEntryForTarget(ctx, operation.targetPath)) {
        await recordAdoption(
          ctx,
          operation.targetPath,
          agent.name,
          await readRegularFileIfExists(
            await resolveInsideRepo(ctx.cwd, operation.targetPath),
          ),
        );
      }
      continue;
    }
    const refusal = await writeAgentFile(
      ctx,
      operation,
      agent.name,
      stagedContentsByPath.get(operation.targetPath) ??
        (await renderAgentFile(agent)),
    );
    if (refusal !== null) {
      skipped.push({ operationId: operation.id, reason: refusal.skipReason });
    }
  }
  return { skipped };
}

async function detectAgents(ctx: Context): Promise<PluginPresence> {
  const operations = await planAgents(ctx);
  return {
    present: operations.every((operation) => operation.action === "conflict"),
    preExisting: pluginActions(ctx).some(
      (action) => action.type === ACTION_TYPE_ADOPTED_AGENT_FILE,
    ),
  };
}

interface AgentFileStatus {
  state: CapabilityState;
  detail: string;
  updateAvailable: boolean;
}

async function agentFileStatus(
  ctx: Context,
  { agent }: CatalogAgent,
): Promise<AgentFileStatus> {
  const target = agentTarget(agent.name);
  const file = await readAgentFile(ctx, target);
  const status = (
    state: CapabilityState,
    detail: string,
    updateAvailable = false,
  ): AgentFileStatus => ({ state, detail, updateAvailable });
  if (file.kind === "not-a-regular-file") {
    return status("unknown", "not a regular file; agemon leaves it alone");
  }
  if (file.contents === null) {
    return status("absent", "run agemon to create it");
  }

  const recorded = ledgerEntryForTarget(ctx, target);
  const claimSuffix =
    recorded === undefined &&
    pluginActions(ctx).some((action) => action.target === target)
      ? CLAIM_SUFFIX
      : "";
  const recordedState: CapabilityState =
    recorded?.type === ACTION_TYPE_MANAGED_AGENT_FILE
      ? "present-managed"
      : "present-adopted";
  if (file.contents === (await renderAgentFile(agent))) {
    return recordedState === "present-managed"
      ? status("present-managed", target)
      : status(
          "present-adopted",
          `identical to agemon's version${claimSuffix}`,
        );
  }
  if (
    recorded !== undefined &&
    recorded.fingerprintAfter === fingerprintContent(file.contents)
  ) {
    return status(recordedState, UPDATE_AVAILABLE_DETAIL, true);
  }
  return recorded === undefined
    ? status(
        "present-modified",
        `differs from agemon's version; agemon keeps yours (conflict)${claimSuffix}`,
      )
    : status(
        "present-modified",
        "changed since agemon wrote it; agemon keeps your version (conflict)",
      );
}

interface ShadowScan {
  shadowingFilesByName: Map<string, string[]>;
  problems: string[];
  capReached: boolean;
}

function comparableAgentName(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

function isQuote(character: string | undefined): boolean {
  return character === '"' || character === "'";
}

function withoutTrailingComment(value: string): string {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "#" && /\s/u.test(value[index - 1])) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquotedFrontmatterValue(rawValue: string): string {
  const value = withoutTrailingComment(rawValue).trim();
  const quote = value[0];
  const isQuoted = value.length >= 2 && isQuote(quote) && value.endsWith(quote);
  return isQuoted ? value.slice(1, -1) : value;
}

function nameValueOf(line: string): string | null {
  if (/^\s/u.test(line)) {
    return null;
  }
  let rest = line;
  const openingQuote = isQuote(rest[0]) ? rest[0] : "";
  rest = rest.slice(openingQuote.length);
  if (!rest.startsWith(NAME_KEY)) {
    return null;
  }
  rest = rest.slice(NAME_KEY.length);
  if (openingQuote !== "") {
    if (!rest.startsWith(openingQuote)) {
      return null;
    }
    rest = rest.slice(1);
  }
  rest = rest.trimStart();
  return rest.startsWith(":") ? unquotedFrontmatterValue(rest.slice(1)) : null;
}

function frontmatterName(prefix: string): string | null {
  const text = prefix.startsWith(BYTE_ORDER_MARK) ? prefix.slice(1) : prefix;
  const lines = text.split("\n", AGENT_FRONTMATTER_MAX_LINES + 1);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return null;
  }
  for (const line of lines.slice(1)) {
    if (line.trim() === FRONTMATTER_FENCE) {
      return null;
    }
    const value = nameValueOf(line);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

async function readFrontmatterPrefix(path: string): Promise<string | null> {
  try {
    return await readRegularFilePrefix(path, AGENT_FRONTMATTER_PREFIX_BYTES);
  } catch {
    return null;
  }
}

const BMP_LAST_CODE_POINT = 0xffff;

function escapedCodePoint(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint > BMP_LAST_CODE_POINT
    ? `\\u{${codePoint.toString(16)}}`
    : `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function escapedUnsafeCharacters(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "\\") {
        return "\\\\";
      }
      return isSafeIdentifier(character)
        ? character
        : escapedCodePoint(character);
    })
    .join("");
}

function displayAgentFileName(fileName: string): string {
  return `${AGENTS_DIRECTORY}/${escapedUnsafeCharacters(fileName)}`;
}

async function scanAgentDirectory(
  directory: string,
  agentNames: string[],
  scan: ShadowScan,
): Promise<void> {
  const agentNameByComparable = new Map(
    agentNames.map((name) => [comparableAgentName(name), name] as const),
  );
  const ownFileNames = new Set(agentNames.map((name) => `${name}.md`));
  let entriesSeen = 0;
  for await (const entry of await opendir(directory)) {
    entriesSeen += 1;
    if (entriesSeen > MAX_AGENT_DIRECTORY_ENTRIES) {
      scan.capReached = true;
      break;
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".md") ||
      ownFileNames.has(entry.name)
    ) {
      continue;
    }
    const prefix = await readFrontmatterPrefix(join(directory, entry.name));
    const declaredName = prefix === null ? null : frontmatterName(prefix);
    const shadowedName =
      declaredName === null
        ? undefined
        : agentNameByComparable.get(comparableAgentName(declaredName));
    if (shadowedName !== undefined) {
      const files = scan.shadowingFilesByName.get(shadowedName) ?? [];
      files.push(displayAgentFileName(entry.name));
      scan.shadowingFilesByName.set(shadowedName, files);
    }
  }
}

async function findShadowingAgentFiles(
  ctx: Context,
  agentNames: string[],
): Promise<ShadowScan> {
  const scan: ShadowScan = {
    shadowingFilesByName: new Map(),
    problems: [],
    capReached: false,
  };
  if (agentNames.length === 0) {
    return scan;
  }
  let directory: string | null;
  try {
    directory = await resolveRepoDirectory(ctx.cwd, AGENTS_DIRECTORY, {
      create: false,
    });
  } catch {
    scan.problems.push(
      `${AGENTS_DIRECTORY} is not a real directory; agemon can't check it`,
    );
    return scan;
  }
  if (directory === null) {
    return scan;
  }
  try {
    await scanAgentDirectory(directory, agentNames, scan);
  } catch {
    scan.problems.push(
      `agemon can't read ${AGENTS_DIRECTORY} to check for same-name agents`,
    );
  }
  return scan;
}

async function retiredAgentRows(ctx: Context): Promise<CapabilityStateRow[]> {
  const rows: CapabilityStateRow[] = [];
  for (const entry of confirmedPluginActions(ctx)) {
    const name = retiredAgentNameForTarget(entry.target);
    if (name === undefined || entry.type !== ACTION_TYPE_MANAGED_AGENT_FILE) {
      continue;
    }
    const file = await readAgentFile(ctx, entry.target);
    if (file.kind === "readable" && file.contents === null) {
      continue;
    }
    rows.push({
      capabilityId: PLUGIN_ID,
      resourceId: agentResourceId(name),
      label: name,
      state: "present-managed",
      detail:
        "agemon no longer ships this agent; 'agemon nuke --only agents' removes it",
    });
  }
  return rows;
}

async function describeAgentsState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const desired = desiredAgents(ctx, []);
  const shadowScan = await findShadowingAgentFiles(
    ctx,
    desired.map(({ agent }) => agent.name),
  );
  const rows: CapabilityStateRow[] = [];
  for (const entry of desired) {
    const { state, detail } = await agentFileStatus(ctx, entry);
    const shadowingFiles =
      shadowScan.shadowingFilesByName.get(entry.agent.name) ?? [];
    rows.push({
      capabilityId: PLUGIN_ID,
      resourceId: agentResourceId(entry.agent.name),
      label: entry.agent.name,
      state,
      detail:
        shadowingFiles.length === 0
          ? detail
          : `${detail}; shadowed by ${shadowingFiles.join(", ")}`,
    });
  }
  return [...rows, ...(await retiredAgentRows(ctx))];
}

async function desiredAgentAttention(ctx: Context): Promise<string[]> {
  const desired = desiredAgents(ctx, []);
  const attention: string[] = [];
  for (const entry of desired) {
    if ((await agentFileStatus(ctx, entry)).updateAvailable) {
      attention.push(
        `agemon has a newer version of ${entry.agent.name}; run agemon to update it`,
      );
    }
  }
  const shadowScan = await findShadowingAgentFiles(
    ctx,
    desired.map(({ agent }) => agent.name),
  );
  for (const [name, files] of shadowScan.shadowingFilesByName) {
    for (const file of files) {
      attention.push(
        `${file} also declares name: ${name}; Claude Code may load it instead of agemon's agent. Rename or remove it.`,
      );
    }
  }
  if (shadowScan.capReached) {
    ctx.ui.info(
      `agents: checked the first ${MAX_AGENT_DIRECTORY_ENTRIES} files in ${AGENTS_DIRECTORY}; a same-name agent beyond them is not checked`,
    );
  }
  return [...attention, ...shadowScan.problems];
}

async function verifyAgents(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }
  const problems: string[] = [];
  const recordedTargets = confirmedPluginActions(ctx)
    .map((action) => action.target)
    .filter((target) => catalogAgentForTarget(target) !== undefined);
  for (const target of recordedTargets) {
    const file = await readAgentFile(ctx, target);
    if (file.kind === "not-a-regular-file") {
      problems.push(`${target} is not a regular file`);
    } else if (file.contents === null) {
      problems.push(
        `${target} is recorded in the ledger but missing; run agemon to recreate it`,
      );
    }
  }
  problems.push(...(await desiredAgentAttention(ctx)));
  return {
    ok: true,
    detail: `${recordedTargets.length} subagent file(s)`,
    ...(problems.length > 0 ? { attention: problems.join("; ") } : {}),
  };
}

class AgentFileRevertError extends Error {
  constructor(
    failures: string[],
    readonly revertedEntryIds: string[],
  ) {
    super(`Could not revert subagent files — ${failures.join("; ")}`);
  }
}

function validatedResourceId(entry: LedgerEntry): string | null {
  const agentName = revertableAgentName(entry.target);
  const isAgentEntry =
    entry.type === ACTION_TYPE_MANAGED_AGENT_FILE ||
    entry.type === ACTION_TYPE_ADOPTED_AGENT_FILE;
  const resourceId =
    agentName === undefined ? null : agentResourceId(agentName);
  return isAgentEntry && resourceId !== null && entry.resourceId === resourceId
    ? resourceId
    : null;
}

interface RevertableEntry {
  entry: LedgerEntry;
  resourceId: string;
}

function revertableManagedEntries(
  ctx: Context,
  entries: LedgerEntry[],
): RevertableEntry[] {
  const revertable: RevertableEntry[] = [];
  for (const entry of entries) {
    const resourceId = validatedResourceId(entry);
    if (resourceId === null) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: the agents capability does not manage that file`,
      );
    } else if (!ctx.manifest.isConfirmed(entry)) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: agemon did not write it on this machine`,
      );
    } else if (entry.type === ACTION_TYPE_MANAGED_AGENT_FILE) {
      revertable.push({ entry, resourceId });
    }
  }
  return revertable;
}

export async function removeEmptyAgentsDirectory(cwd: string): Promise<void> {
  try {
    const directory = await resolveRepoDirectory(cwd, AGENTS_DIRECTORY, {
      create: false,
    });
    if (directory !== null) {
      await rmdir(directory);
    }
  } catch {
    // Best effort: a non-empty, missing, refused or busy directory stays as it is.
  }
}

async function revertAgents(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  const managedEntries = revertableManagedEntries(ctx, entries);

  if (ctx.dryRun) {
    for (const { entry } of managedEntries) {
      ctx.ui.info(`Would revert subagent file ${entry.target}`);
    }
    return;
  }

  const failures: string[] = [];
  const revertedEntryIds: string[] = [];
  let createdFileReverted = false;
  for (const { entry, resourceId } of managedEntries) {
    try {
      await revertManagedFile(ctx, entry, {
        backupCandidates: immutableBackupCandidates(
          ctx.cwd,
          resourceId,
          entry.backup?.path ?? null,
        ),
      });
      revertedEntryIds.push(entry.id);
      createdFileReverted ||= !entry.preExisting;
    } catch (error) {
      failures.push(
        `${printable(entry.target)}: ${printable(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
  if (createdFileReverted) {
    await removeEmptyAgentsDirectory(ctx.cwd);
  }
  if (failures.length > 0) {
    throw new AgentFileRevertError(failures, revertedEntryIds);
  }
}

async function uninstallAgents(ctx: Context): Promise<void> {
  try {
    await revertAgents(ctx, pluginActions(ctx));
  } catch (error) {
    if (error instanceof AgentFileRevertError) {
      await ctx.manifest.removeActionIds(error.revertedEntryIds);
    }
    throw error;
  }
}

export const agentsPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  dependsOn: [SKILLS_PLUGIN_ID],
  riskClass: "writes-config",
  detect: detectAgents,
  describeState: describeAgentsState,
  plan: planAgents,
  materialize: materializeAgents,
  apply: applyAgents,
  verify: verifyAgents,
  revert: revertAgents,
  uninstall: uninstallAgents,
};
