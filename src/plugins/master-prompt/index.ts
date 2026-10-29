import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  immutableBackupCandidates,
  replaceStaleBackup,
  resolveV1RuleFileBackupPath,
  writeImmutableBackup,
} from "../../core/backups.js";
import type { Context } from "../../core/context.js";
import {
  MAX_READ_FILE_LABEL,
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "../../core/files.js";
import { fingerprintContent, fingerprintJson } from "../../core/fingerprint.js";
import { revertManagedFile } from "../../core/managed-file-revert.js";
import { resolveInsideRepo } from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { printable } from "../../core/untrusted-text.js";
import { detectDuplication } from "../../inspect/duplication.js";
import {
  removeManagedMarkdownBlock,
  upsertManagedMarkdownBlock,
} from "../../patchers/markdown-block.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  ProposedOperationAction,
  StagedFile,
} from "../types.js";

const PLUGIN_ID = "master-prompt";
const AGENTS_FILE = "AGENTS.md";
const AGENT_RULES_BLOCK_ID = "agent-rules";
const AGENT_RULES_START_MARKER = `<!-- agemon:start:${AGENT_RULES_BLOCK_ID} -->`;

const ACTION_TYPE_MANAGED_RULE_FILE = "managed-rule-file";
const ACTION_TYPE_ADOPTED_POINTER = "adopted-pointer";

const POINTER_MAX_NORMALIZED_LENGTH = 800;
const UNREADABLE_RULE_FILE = Symbol("unreadable rule file");

interface PointerTarget {
  target: string;
  toolName: string;
}

const POINTER_TARGETS: PointerTarget[] = [
  { target: "CLAUDE.md", toolName: "Claude Code" },
  { target: "GEMINI.md", toolName: "Gemini CLI" },
  { target: ".cursorrules", toolName: "Cursor" },
  { target: ".windsurfrules", toolName: "Windsurf" },
];

const ALLOWED_ACTIONS_BY_KIND: Record<
  ClassifiedRuleFile["kind"],
  readonly ProposedOperationAction[]
> = {
  agents: ["create", "merge-block", "conflict"],
  pointer: ["create", "replace", "adopt", "conflict"],
};

type RuleFileState =
  | "not-a-regular-file"
  | "absent"
  | "managed-current"
  | "managed-drifted"
  | "mergeable"
  | "equivalent"
  | "conflict";

interface ClassifiedRuleFile {
  target: string;
  kind: "agents" | "pointer";
  state: RuleFileState;
  currentContents: string | null;
}

function buildAgentRulesBlockBody(): string {
  return [
    "# AI Agent Rules",
    "",
    "This block is the canonical, repo-wide rule set for every AI coding agent in this",
    "repository. `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, and `.windsurfrules` are pointer",
    "files that exist only because their tools look for those exact names — read this first.",
    "",
    "## Task Lifecycle",
    "",
    "Apply this sequence to every task:",
    "",
    "1. Discover existing skills, tools, utilities, and conventions before writing new code.",
    "2. Plan the smallest complete change; state assumptions and tradeoffs before implementing.",
    "3. Verify assumptions with tests or reproducible checks.",
    "4. Implement with clear names, modular boundaries, and no dead code.",
    "5. Re-verify after the change and confirm no regressions were introduced.",
    "6. Record anything out of scope in `improvements.md` instead of fixing it inline.",
    "",
    "## Core Directives",
    "",
    "- Simplicity first: the minimum code that solves the problem, nothing speculative.",
    "- Reuse existing project utilities instead of duplicating logic.",
    "- Match the surrounding code's style, naming, and structure.",
    "- Keep every change surgical: touch only what the task requires.",
    "- Zero waste in your own changes: no unused imports, variables, or dead branches.",
    "- Self-documenting code: descriptive names and named constants over explanatory comments.",
    "- Preserve user-authored content outside agemon-managed files and blocks.",
    "- Prefer safe, reversible changes; call out irreversible or outward-facing steps first.",
    "- Security and performance by default within scope: validate input, least privilege,",
    "  no needless recomputation.",
    "",
    "## Output Conventions",
    "",
    "- Reference real, existing file paths.",
    "- Mark the file path above each changed code block.",
    "- End every task with a short summary of what changed and why.",
  ].join("\n");
}

function buildPointerFileContents(
  toolName: string,
  targetFileName: string,
): string {
  return [
    "<!-- AI agent rules pointer -->",
    "# AI Agent Rules",
    "",
    "The canonical rules for this repo live in AGENTS.md — read that file in full before",
    "making any changes here. This file exists only because " +
      `${toolName} looks for \`${targetFileName}\` specifically; it intentionally does not restate the rules.`,
    "",
  ].join("\n");
}

function pointerContentsFor(target: string): string {
  const pointer = POINTER_TARGETS.find((entry) => entry.target === target);
  if (!pointer) {
    throw new Error(`No pointer definition for '${target}'.`);
  }
  return buildPointerFileContents(pointer.toolName, pointer.target);
}

function ruleFileKind(target: string): ClassifiedRuleFile["kind"] | null {
  if (target === AGENTS_FILE) {
    return "agents";
  }
  return POINTER_TARGETS.some((pointer) => pointer.target === target)
    ? "pointer"
    : null;
}

function assertMasterPromptPerforms(operation: ProposedOperation): void {
  const kind = ruleFileKind(operation.targetPath);
  if (
    kind === null ||
    !ALLOWED_ACTIONS_BY_KIND[kind].includes(operation.action)
  ) {
    throw new Error(
      `Plan operation ${printable(operation.id)} is not something master-prompt does (${operation.action} ${printable(operation.targetPath)}).`,
    );
  }
}

function ruleFileResourceId(target: string): string {
  return `rule-file:${target}`;
}

function ruleFileTargetFromResourceId(resourceId: string): string | null {
  const prefix = "rule-file:";
  return resourceId.startsWith(prefix) ? resourceId.slice(prefix.length) : null;
}

function desiredRevisionForTarget(target: string): string | null {
  if (target === AGENTS_FILE) {
    return fingerprintJson({
      block: buildAgentRulesBlockBody(),
      pointer: null,
    });
  }
  if (POINTER_TARGETS.some((pointer) => pointer.target === target)) {
    return fingerprintJson({
      block: null,
      pointer: pointerContentsFor(target),
    });
  }
  return null;
}

function masterPromptDesiredRevision(
  _ctx: Context,
  resourceId: string,
): string | null {
  const target = ruleFileTargetFromResourceId(resourceId);
  return target === null ? null : desiredRevisionForTarget(target);
}

function pluginActions(ctx: Context): LedgerEntry[] {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function ledgerActionForTarget(
  ctx: Context,
  target: string,
): LedgerEntry | undefined {
  return pluginActions(ctx).find((action) => action.target === target);
}

function hasActionForTarget(ctx: Context, target: string): boolean {
  return ledgerActionForTarget(ctx, target) !== undefined;
}

function looksLikePointer(contents: string): boolean {
  if (!/AGENTS\.md/i.test(contents)) {
    return false;
  }
  return (
    contents.replace(/\s+/gu, " ").trim().length <=
    POINTER_MAX_NORMALIZED_LENGTH
  );
}

function agentsFileNeedsBlock(contents: string): boolean {
  return !contents.includes(AGENT_RULES_START_MARKER);
}

function agentsBlockIsDrifted(contents: string): boolean {
  return upsertManagedMarkdownBlock(
    contents,
    AGENT_RULES_BLOCK_ID,
    buildAgentRulesBlockBody(),
  ).changed;
}

function classifyAgentsFile(contents: string | null): RuleFileState {
  if (contents === null || contents.trim().length === 0) {
    return "absent";
  }
  if (agentsFileNeedsBlock(contents)) {
    return "mergeable";
  }
  return agentsBlockIsDrifted(contents) ? "managed-drifted" : "managed-current";
}

function classifyPointerFile(
  ctx: Context,
  target: string,
  contents: string | null,
): RuleFileState {
  if (contents === null) {
    return "absent";
  }

  const action = ledgerActionForTarget(ctx, target);
  if (action) {
    if (action.type === ACTION_TYPE_ADOPTED_POINTER) {
      return "managed-current";
    }
    return contents === pointerContentsFor(target)
      ? "managed-current"
      : "managed-drifted";
  }

  return looksLikePointer(contents) ? "equivalent" : "conflict";
}

async function classifyRuleFile(
  ctx: Context,
  target: string,
  kind: ClassifiedRuleFile["kind"],
): Promise<ClassifiedRuleFile> {
  let contents: string | null;
  try {
    contents = await readRegularFileIfExists(join(ctx.cwd, target));
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return {
        target,
        kind,
        state: "not-a-regular-file",
        currentContents: null,
      };
    }
    throw error;
  }
  const state =
    kind === "agents"
      ? classifyAgentsFile(contents)
      : classifyPointerFile(ctx, target, contents);
  return { target, kind, state, currentContents: contents };
}

async function classifyRuleFiles(ctx: Context): Promise<ClassifiedRuleFile[]> {
  const classified = [await classifyRuleFile(ctx, AGENTS_FILE, "agents")];
  for (const pointer of POINTER_TARGETS) {
    classified.push(await classifyRuleFile(ctx, pointer.target, "pointer"));
  }
  return classified;
}

function renderRuleFileContents(
  target: string,
  contentsBefore: string | null,
): string {
  if (target === AGENTS_FILE) {
    return upsertManagedMarkdownBlock(
      contentsBefore ?? "",
      AGENT_RULES_BLOCK_ID,
      buildAgentRulesBlockBody(),
    ).nextContent;
  }
  return pointerContentsFor(target);
}

function proposedContentsFor(entry: ClassifiedRuleFile): string {
  return renderRuleFileContents(entry.target, entry.currentContents);
}

function operationWritesRuleFile(operation: ProposedOperation): boolean {
  return operation.action !== "conflict" && operation.action !== "adopt";
}

async function materializeMasterPrompt(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  for (const operation of operations) {
    assertMasterPromptPerforms(operation);
    if (!operationWritesRuleFile(operation)) {
      continue;
    }
    const contentsBefore = await readRegularFileIfExists(
      await resolveInsideRepo(ctx.cwd, operation.targetPath),
    );
    staged.push({
      targetPath: operation.targetPath,
      contents: renderRuleFileContents(operation.targetPath, contentsBefore),
      kind: "markdown",
    });
  }
  return staged;
}

function operationForClassifiedFile(
  entry: ClassifiedRuleFile,
): ProposedOperation | null {
  if (entry.state === "managed-current") {
    return null;
  }

  const expectedFingerprint =
    entry.currentContents === null
      ? null
      : fingerprintContent(entry.currentContents);

  if (entry.state === "not-a-regular-file") {
    return describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: ruleFileResourceId(entry.target),
      targetPath: entry.target,
      action: "conflict",
      riskClass: "writes-config",
      requiresConsent: true,
      expectedFingerprint,
      preview: {
        kind: "note",
        text: `${entry.target} is a symlink, special file or larger than ${MAX_READ_FILE_LABEL}; agemon leaves it alone.`,
      },
    });
  }

  if (entry.state === "conflict") {
    return describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: ruleFileResourceId(entry.target),
      targetPath: entry.target,
      action: "conflict",
      riskClass: "writes-config",
      requiresConsent: true,
      expectedFingerprint,
      preview: {
        kind: "note",
        text: `${entry.target} carries independent rules that duplicate guidance belonging in ${AGENTS_FILE}; keep yours, or replace it with a pointer.`,
      },
    });
  }

  if (entry.state === "equivalent") {
    return describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: ruleFileResourceId(entry.target),
      targetPath: entry.target,
      action: "adopt",
      riskClass: "writes-config",
      requiresConsent: true,
      expectedFingerprint,
      preview: {
        kind: "note",
        text: `${entry.target} already points to ${AGENTS_FILE}; record the adoption in the ledger and write nothing.`,
      },
    });
  }

  const action =
    entry.state === "absent"
      ? "create"
      : entry.kind === "agents"
        ? "merge-block"
        : "replace";

  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: ruleFileResourceId(entry.target),
    targetPath: entry.target,
    action,
    riskClass: "writes-config",
    requiresConsent: true,
    expectedFingerprint,
    preview: {
      kind: "diff",
      text: renderUnifiedDiff(
        entry.currentContents ?? "",
        proposedContentsFor(entry),
        entry.target,
      ),
    },
  });
}

async function planMasterPrompt(ctx: Context): Promise<ProposedOperation[]> {
  const classified = await classifyRuleFiles(ctx);
  const operations: ProposedOperation[] = [];
  for (const entry of classified) {
    const operation = operationForClassifiedFile(entry);
    if (operation) {
      operations.push(operation);
    }
  }
  return operations;
}

async function recordManagedRuleFile(
  ctx: Context,
  input: {
    target: string;
    ownershipMode: "created" | "delimited-block";
    contentsBefore: string | null;
    contentsAfter: string;
    backup: { path: string; checksum: string } | null;
  },
): Promise<void> {
  const fingerprintAfter = fingerprintContent(input.contentsAfter);
  const desiredRevision = desiredRevisionForTarget(input.target);

  if (hasActionForTarget(ctx, input.target)) {
    await ctx.manifest.updateResourceEntry(ruleFileResourceId(input.target), {
      fingerprintAfter,
      desiredRevision,
    });
    return;
  }

  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_MANAGED_RULE_FILE,
    target: input.target,
    preExisting: input.contentsBefore !== null,
    resourceId: ruleFileResourceId(input.target),
    ownershipMode: input.ownershipMode,
    fingerprintBefore:
      input.contentsBefore === null
        ? null
        : fingerprintContent(input.contentsBefore),
    fingerprintAfter,
    desiredRevision,
    backup: input.backup,
  });
}

async function backupContentsBefore(
  ctx: Context,
  target: string,
  contentsBefore: string,
) {
  const resourceId = ruleFileResourceId(target);
  return hasActionForTarget(ctx, target)
    ? writeImmutableBackup(ctx.cwd, resourceId, contentsBefore)
    : replaceStaleBackup(ctx.cwd, resourceId, contentsBefore);
}

async function applyRuleFileOperation(
  ctx: Context,
  operation: ProposedOperation,
  stagedContents: string | undefined,
): Promise<void> {
  const targetPath = await resolveInsideRepo(ctx.cwd, operation.targetPath);
  const contentsBefore = await readRegularFileIfExists(targetPath);

  if (operation.action === "adopt") {
    if (hasActionForTarget(ctx, operation.targetPath)) {
      return;
    }
    const fingerprint =
      contentsBefore === null ? null : fingerprintContent(contentsBefore);
    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_ADOPTED_POINTER,
      target: operation.targetPath,
      preExisting: true,
      resourceId: ruleFileResourceId(operation.targetPath),
      ownershipMode: "recorded-key",
      fingerprintBefore: fingerprint,
      fingerprintAfter: fingerprint,
      backup: null,
    });
    return;
  }

  const contentsAfter =
    stagedContents ??
    renderRuleFileContents(operation.targetPath, contentsBefore);

  const backup =
    contentsBefore === null
      ? null
      : await backupContentsBefore(ctx, operation.targetPath, contentsBefore);

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFileAtomic(targetPath, contentsAfter);

  await recordManagedRuleFile(ctx, {
    target: operation.targetPath,
    ownershipMode:
      operation.targetPath === AGENTS_FILE ? "delimited-block" : "created",
    contentsBefore,
    contentsAfter,
    backup:
      backup === null ? null : { path: backup.path, checksum: backup.checksum },
  });
}

async function applyMasterPrompt(
  ctx: Context,
  operations: ProposedOperation[],
  staged?: StagedFile[],
): Promise<void> {
  const stagedContentsByPath = new Map(
    (staged ?? []).map((file) => [file.targetPath, file.contents] as const),
  );
  for (const operation of operations) {
    assertMasterPromptPerforms(operation);
    if (operation.action === "conflict") {
      continue;
    }
    await applyRuleFileOperation(
      ctx,
      operation,
      stagedContentsByPath.get(operation.targetPath),
    );
  }
}

async function detectMasterPrompt(ctx: Context): Promise<PluginPresence> {
  const operations = await planMasterPrompt(ctx);
  const actionable = operations.filter(
    (operation) => operation.action !== "conflict",
  );
  const classified = await classifyRuleFiles(ctx);
  return {
    present: actionable.length === 0,
    preExisting: classified.some(
      (entry) =>
        entry.state === "equivalent" ||
        entry.state === "conflict" ||
        entry.state === "mergeable" ||
        entry.state === "managed-drifted",
    ),
  };
}

async function installMasterPrompt(ctx: Context): Promise<void> {
  const operations = await planMasterPrompt(ctx);

  if (ctx.dryRun) {
    for (const operation of operations) {
      ctx.ui.info(
        `Would ${operation.action} rule file ${operation.targetPath}`,
      );
    }
    return;
  }

  await applyMasterPrompt(ctx, operations);
}

async function verifyMasterPrompt(
  ctx: Context,
): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const problems: string[] = [];
  const readForVerification = async (
    target: string,
  ): Promise<string | null | typeof UNREADABLE_RULE_FILE> => {
    try {
      return await readRegularFileIfExists(join(ctx.cwd, target));
    } catch (error) {
      if (!(error instanceof RefusedFileError)) {
        throw error;
      }
      problems.push(error.message);
      return UNREADABLE_RULE_FILE;
    }
  };

  const agentsContents = await readForVerification(AGENTS_FILE);
  if (agentsContents !== UNREADABLE_RULE_FILE) {
    if (agentsContents === null || agentsFileNeedsBlock(agentsContents)) {
      problems.push(`${AGENTS_FILE} is missing agemon's managed block`);
    } else if (agentsBlockIsDrifted(agentsContents)) {
      problems.push(`${AGENTS_FILE} managed block drifted from its template`);
    }
  }

  const managedRuleFiles: { path: string; contents: string | null }[] = [
    {
      path: AGENTS_FILE,
      contents: agentsContents === UNREADABLE_RULE_FILE ? null : agentsContents,
    },
  ];
  for (const pointer of POINTER_TARGETS) {
    if (!hasActionForTarget(ctx, pointer.target)) {
      continue;
    }
    const contents = await readForVerification(pointer.target);
    if (contents === UNREADABLE_RULE_FILE) {
      continue;
    }
    if (contents === null) {
      problems.push(`${pointer.target} is recorded in the ledger but missing`);
      continue;
    }
    managedRuleFiles.push({ path: pointer.target, contents });
  }

  const duplicateGuidance = detectDuplication(managedRuleFiles).overlaps;
  if (duplicateGuidance.length > 0) {
    problems.push(
      `duplicate guidance across managed files: ${duplicateGuidance
        .map((overlap) => `${overlap.left} ~ ${overlap.right}`)
        .join(", ")}`,
    );
  }

  if (problems.length > 0) {
    return { ok: false, detail: problems.join("; ") };
  }

  return {
    ok: true,
    detail: `${managedRuleFiles.length} managed rule file(s), no duplicate guidance`,
  };
}

class RuleFileRevertError extends Error {
  constructor(
    failures: string[],
    readonly revertedEntryIds: string[],
  ) {
    super(`Could not revert rule files — ${failures.join("; ")}`);
  }
}

async function revertMasterPrompt(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  const ruleFileActions = entries.filter(
    (entry) => entry.type === ACTION_TYPE_MANAGED_RULE_FILE,
  );
  const managedActions = ruleFileActions.filter(
    (entry) => ruleFileKind(entry.target) !== null,
  );
  for (const unmanaged of ruleFileActions) {
    if (ruleFileKind(unmanaged.target) === null) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(unmanaged.target)}: master-prompt does not manage that file`,
      );
    }
  }

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep every pre-existing rule file untouched");
      return;
    }
    for (const action of managedActions) {
      ctx.ui.info(`Would revert rule file ${action.target}`);
    }
    return;
  }

  const failures: string[] = [];
  const revertedEntryIds: string[] = [];
  for (const action of managedActions) {
    try {
      await revertManagedRuleFile(ctx, action);
      revertedEntryIds.push(action.id);
    } catch (error) {
      failures.push(
        `${printable(action.target)}: ${printable(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new RuleFileRevertError(failures, revertedEntryIds);
  }
}

function backupCandidatesFor(ctx: Context, action: LedgerEntry): string[] {
  return [
    ...immutableBackupCandidates(
      ctx.cwd,
      ruleFileResourceId(action.target),
      action.backup?.path ?? null,
    ),
    resolveV1RuleFileBackupPath(ctx.cwd, action.target),
  ];
}

function exciseAgentRulesBlock(contents: string): string | null {
  try {
    const excised = removeManagedMarkdownBlock(contents, AGENT_RULES_BLOCK_ID);
    return excised.changed ? excised.nextContent : null;
  } catch {
    return null;
  }
}

async function revertManagedRuleFile(
  ctx: Context,
  action: LedgerEntry,
): Promise<void> {
  await revertManagedFile(ctx, action, {
    backupCandidates: backupCandidatesFor(ctx, action),
    salvage: exciseAgentRulesBlock,
  });
}

async function uninstallMasterPrompt(ctx: Context): Promise<void> {
  try {
    await revertMasterPrompt(ctx, pluginActions(ctx));
  } catch (error) {
    if (error instanceof RuleFileRevertError) {
      await ctx.manifest.removeActionIds(error.revertedEntryIds);
    }
    throw error;
  }
}

export const masterPromptPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "writes-config",
  detect: detectMasterPrompt,
  desiredRevision: masterPromptDesiredRevision,
  plan: planMasterPrompt,
  materialize: materializeMasterPrompt,
  apply: applyMasterPrompt,
  install: installMasterPrompt,
  verify: verifyMasterPrompt,
  revert: revertMasterPrompt,
  uninstall: uninstallMasterPrompt,
};
