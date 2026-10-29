import { readFile, rmdir } from "node:fs/promises";
import { relative } from "node:path";
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
  resolveInsideRepo,
  resolveRepoDirectory,
} from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { printable } from "../../core/untrusted-text.js";
import { describeOperation } from "../proposed-operation.js";
import {
  type AgentDefinition,
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
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  ProposedOperationAction,
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

function ledgerEntryForTarget(
  ctx: Context,
  target: string,
): LedgerEntry | undefined {
  return pluginActions(ctx).find((action) => action.target === target);
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
): Promise<void> {
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
    return;
  }

  const earlierOriginalPath =
    contentsBefore === null
      ? null
      : await differentEarlierOriginalPath(ctx, name, contentsBefore);
  if (earlierOriginalPath !== null) {
    ctx.ui.info(
      `skipped ${target}: agemon already keeps an earlier original of it at ${relative(ctx.cwd, earlierOriginalPath)}; keep your version, or delete ${target} and re-run agemon`,
    );
    return;
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
}

async function applyAgents(
  ctx: Context,
  operations: ProposedOperation[],
  staged?: StagedFile[],
): Promise<void> {
  const stagedContentsByPath = new Map(
    (staged ?? []).map((file) => [file.targetPath, file.contents] as const),
  );
  const installedGroupIds = recordedBuiltInGroupIds(ctx);
  for (const operation of operations) {
    const { group, agent } = assertAgentsPerforms(operation);
    if (operation.action === "conflict") {
      continue;
    }
    if (!installedGroupIds.has(group.id)) {
      ctx.ui.info(
        `skipped agent ${agent.name}: its skill group ${group.id} is not installed; approve the skill group install to get it`,
      );
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
    await writeAgentFile(
      ctx,
      operation,
      agent.name,
      stagedContentsByPath.get(operation.targetPath) ??
        (await renderAgentFile(agent)),
    );
  }
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

async function installAgents(ctx: Context): Promise<void> {
  const operations = await planAgents(ctx);
  if (ctx.dryRun) {
    for (const operation of operations) {
      ctx.ui.info(`Would ${operation.action} ${operation.targetPath}`);
    }
    return;
  }
  await applyAgents(ctx, operations);
}

async function verifyAgents(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }
  const problems: string[] = [];
  const recordedTargets = pluginActions(ctx)
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
  const catalogEntry = catalogAgentForTarget(entry.target);
  const isAgentEntry =
    entry.type === ACTION_TYPE_MANAGED_AGENT_FILE ||
    entry.type === ACTION_TYPE_ADOPTED_AGENT_FILE;
  const resourceId =
    catalogEntry === undefined
      ? null
      : agentResourceId(catalogEntry.agent.name);
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
  plan: planAgents,
  materialize: materializeAgents,
  apply: applyAgents,
  install: installAgents,
  verify: verifyAgents,
  revert: revertAgents,
  uninstall: uninstallAgents,
};
