import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  resolveImmutableBackupPath,
  writeImmutableBackup,
} from "../../core/backups.js";
import type { Context } from "../../core/context.js";
import { fingerprintContent } from "../../core/fingerprint.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { detectDuplication } from "../../inspect/duplication.js";
import { upsertManagedMarkdownBlock } from "../../patchers/markdown-block.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
} from "../types.js";

const PLUGIN_ID = "master-prompt";
const AGENTS_FILE = "AGENTS.md";
const AGENT_RULES_BLOCK_ID = "agent-rules";
const AGENT_RULES_START_MARKER = `<!-- agemon:start:${AGENT_RULES_BLOCK_ID} -->`;

const ACTION_TYPE_MANAGED_RULE_FILE = "managed-rule-file";
const ACTION_TYPE_ADOPTED_POINTER = "adopted-pointer";

const POINTER_MAX_NORMALIZED_LENGTH = 800;

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

type RuleFileState =
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

function ruleFileResourceId(target: string): string {
  return `rule-file:${target}`;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
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

function managedRuleFileActions(ctx: Context): LedgerEntry[] {
  return pluginActions(ctx).filter(
    (action) => action.type === ACTION_TYPE_MANAGED_RULE_FILE,
  );
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

async function classifyRuleFiles(ctx: Context): Promise<ClassifiedRuleFile[]> {
  const agentsContents = await readFileIfExists(join(ctx.cwd, AGENTS_FILE));
  const classified: ClassifiedRuleFile[] = [
    {
      target: AGENTS_FILE,
      kind: "agents",
      state: classifyAgentsFile(agentsContents),
      currentContents: agentsContents,
    },
  ];

  for (const pointer of POINTER_TARGETS) {
    const contents = await readFileIfExists(join(ctx.cwd, pointer.target));
    classified.push({
      target: pointer.target,
      kind: "pointer",
      state: classifyPointerFile(ctx, pointer.target, contents),
      currentContents: contents,
    });
  }

  return classified;
}

function proposedContentsFor(entry: ClassifiedRuleFile): string {
  if (entry.kind === "agents") {
    return upsertManagedMarkdownBlock(
      entry.currentContents ?? "",
      AGENT_RULES_BLOCK_ID,
      buildAgentRulesBlockBody(),
    ).nextContent;
  }
  return pointerContentsFor(entry.target);
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
  if (hasActionForTarget(ctx, input.target)) {
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
    fingerprintAfter: fingerprintContent(input.contentsAfter),
    backup: input.backup,
  });
}

async function applyRuleFileOperation(
  ctx: Context,
  operation: ProposedOperation,
): Promise<void> {
  const targetPath = join(ctx.cwd, operation.targetPath);
  const contentsBefore = await readFileIfExists(targetPath);

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
    operation.targetPath === AGENTS_FILE
      ? upsertManagedMarkdownBlock(
          contentsBefore ?? "",
          AGENT_RULES_BLOCK_ID,
          buildAgentRulesBlockBody(),
        ).nextContent
      : pointerContentsFor(operation.targetPath);

  const backup =
    contentsBefore !== null
      ? await writeImmutableBackup(
          ctx.cwd,
          ruleFileResourceId(operation.targetPath),
          contentsBefore,
        )
      : null;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contentsAfter, "utf8");

  await recordManagedRuleFile(ctx, {
    target: operation.targetPath,
    ownershipMode:
      operation.targetPath === AGENTS_FILE ? "delimited-block" : "created",
    contentsBefore,
    contentsAfter,
    backup,
  });
}

async function applyMasterPrompt(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.action === "conflict") {
      continue;
    }
    await applyRuleFileOperation(ctx, operation);
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

  const agentsContents = await readFileIfExists(join(ctx.cwd, AGENTS_FILE));
  if (agentsContents === null || agentsFileNeedsBlock(agentsContents)) {
    problems.push(`${AGENTS_FILE} is missing agemon's managed block`);
  } else if (agentsBlockIsDrifted(agentsContents)) {
    problems.push(`${AGENTS_FILE} managed block drifted from its template`);
  }

  const managedRuleFiles: { path: string; contents: string | null }[] = [
    { path: AGENTS_FILE, contents: agentsContents },
  ];
  for (const pointer of POINTER_TARGETS) {
    if (!hasActionForTarget(ctx, pointer.target)) {
      continue;
    }
    const contents = await readFileIfExists(join(ctx.cwd, pointer.target));
    if (contents === null) {
      problems.push(`${pointer.target} is recorded in the ledger but missing`);
      continue;
    }
    managedRuleFiles.push({ path: pointer.target, contents });
  }

  const duplicateGuidance = detectDuplication(managedRuleFiles).overlaps.filter(
    (overlap) => overlap.left === AGENTS_FILE || overlap.right === AGENTS_FILE,
  );
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

async function uninstallMasterPrompt(ctx: Context): Promise<void> {
  const managedActions = managedRuleFileActions(ctx);

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep every pre-existing rule file untouched");
      return;
    }
    for (const action of managedActions) {
      if (action.preExisting) {
        ctx.ui.info(`Would restore original rule file ${action.target}`);
      } else {
        ctx.ui.info(`Would remove generated rule file ${action.target}`);
      }
    }
    return;
  }

  for (const action of managedActions) {
    const targetPath = join(ctx.cwd, action.target);
    const backupPath =
      action.backup?.path ??
      resolveImmutableBackupPath(ctx.cwd, ruleFileResourceId(action.target));

    if (action.preExisting) {
      if (!existsSync(backupPath)) {
        throw new Error(
          `Missing backup for pre-existing file ${action.target}`,
        );
      }
      const backupContents = await readFile(backupPath, "utf8");
      await writeFile(targetPath, backupContents, "utf8");
      await rm(backupPath, { force: true });
      continue;
    }

    await rm(targetPath, { force: true });
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const masterPromptPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "writes-config",
  detect: detectMasterPrompt,
  plan: planMasterPrompt,
  apply: applyMasterPrompt,
  install: installMasterPrompt,
  verify: verifyMasterPrompt,
  uninstall: uninstallMasterPrompt,
};
