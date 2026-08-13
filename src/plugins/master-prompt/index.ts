import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";

const PLUGIN_ID = "master-prompt";
const ACTION_TYPE_MANAGED_RULE_FILE = "managed-rule-file";
const ACTION_TYPE_PREEXISTING_RULE_FILE = "preexisting-rule-file";
const BACKUP_DIRECTORY = ".agemon/backups/master-prompt";

interface RuleFileDefinition {
  target: string;
  contents: string;
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

function buildAgentsFileContents(): string {
  return [
    "# AI Agent Rules",
    "",
    "This is the canonical, repo-wide rule set for every AI coding agent in this repository.",
    "`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, and `GEMINI.md` are pointer files that",
    "exist only because their tools look for those exact filenames.",
    "",
    "## Standard Task Lifecycle",
    "",
    "1. Discover existing tools, skills, and patterns before writing new code.",
    "2. Plan the smallest complete change before implementation.",
    "3. Verify assumptions with tests or reproducible checks.",
    "4. Implement with clear naming, modular boundaries, and zero dead code.",
    "5. Re-verify after changes and record out-of-scope findings in improvements.md.",
    "",
    "## Core Directives",
    "",
    "- Keep code simple and task-scoped: no speculative abstractions.",
    "- Reuse existing project utilities instead of duplicating logic.",
    "- Preserve user-authored content outside agemon-managed files.",
    "- Prioritize safe and reversible changes.",
    "",
  ].join("\n");
}

function getRuleFileDefinitions(): RuleFileDefinition[] {
  return [
    {
      target: "AGENTS.md",
      contents: buildAgentsFileContents(),
    },
    {
      target: "CLAUDE.md",
      contents: buildPointerFileContents("Claude Code", "CLAUDE.md"),
    },
    {
      target: "GEMINI.md",
      contents: buildPointerFileContents("Gemini CLI", "GEMINI.md"),
    },
    {
      target: ".cursorrules",
      contents: buildPointerFileContents("Cursor", ".cursorrules"),
    },
    {
      target: ".windsurfrules",
      contents: buildPointerFileContents("Windsurf", ".windsurfrules"),
    },
  ];
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function hasActionForTarget(ctx: Context, target: string): boolean {
  return getPluginActions(ctx).some((action) => action.target === target);
}

function getManagedActions(ctx: Context) {
  return getPluginActions(ctx).filter(
    (action) => action.type === ACTION_TYPE_MANAGED_RULE_FILE,
  );
}

function encodeTargetAsBackupFileName(target: string): string {
  return target.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function buildBackupPath(cwd: string, target: string): string {
  return join(
    cwd,
    BACKUP_DIRECTORY,
    `${encodeTargetAsBackupFileName(target)}.bak`,
  );
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function allRuleFilesMatch(ctx: Context): Promise<boolean>[] {
  return getRuleFileDefinitions().map(async (definition) => {
    const targetPath = join(ctx.cwd, definition.target);
    const currentContents = await readFileIfExists(targetPath);
    return currentContents === definition.contents;
  });
}

async function detectMasterPrompt(ctx: Context): Promise<PluginPresence> {
  const matchResults = await Promise.all(allRuleFilesMatch(ctx));
  const allMatch = matchResults.every((matches) => matches);

  if (!allMatch) {
    return { present: false, preExisting: false };
  }

  if (!ctx.dryRun) {
    for (const definition of getRuleFileDefinitions()) {
      if (hasActionForTarget(ctx, definition.target)) {
        continue;
      }
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_PREEXISTING_RULE_FILE,
        target: definition.target,
        preExisting: true,
      });
    }
  }

  const allManaged = getRuleFileDefinitions().every((definition) =>
    getManagedActions(ctx).some(
      (action) => action.target === definition.target,
    ),
  );

  return { present: true, preExisting: !allManaged };
}

async function backupOriginalFileIfNeeded(
  cwd: string,
  target: string,
  existingContents: string,
): Promise<void> {
  const backupPath = buildBackupPath(cwd, target);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, existingContents, "utf8");
}

async function installMasterPrompt(ctx: Context): Promise<void> {
  if (ctx.dryRun) {
    for (const definition of getRuleFileDefinitions()) {
      ctx.ui.info(`Would consolidate rule file ${definition.target}`);
    }
    return;
  }

  for (const definition of getRuleFileDefinitions()) {
    const targetPath = join(ctx.cwd, definition.target);
    const existingContents = await readFileIfExists(targetPath);

    if (existingContents === definition.contents) {
      if (!hasActionForTarget(ctx, definition.target)) {
        await ctx.manifest.recordAction({
          plugin: PLUGIN_ID,
          type: ACTION_TYPE_PREEXISTING_RULE_FILE,
          target: definition.target,
          preExisting: true,
        });
      }
      continue;
    }

    if (existingContents !== null) {
      await backupOriginalFileIfNeeded(
        ctx.cwd,
        definition.target,
        existingContents,
      );
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, definition.contents, "utf8");

    if (!hasActionForTarget(ctx, definition.target)) {
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_MANAGED_RULE_FILE,
        target: definition.target,
        preExisting: existingContents !== null,
      });
    }
  }
}

async function verifyMasterPrompt(
  ctx: Context,
): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const missingOrMismatchedTargets: string[] = [];
  for (const definition of getRuleFileDefinitions()) {
    const targetPath = join(ctx.cwd, definition.target);
    const currentContents = await readFileIfExists(targetPath);
    if (currentContents !== definition.contents) {
      missingOrMismatchedTargets.push(definition.target);
    }
  }

  if (missingOrMismatchedTargets.length > 0) {
    return {
      ok: false,
      detail: `Missing or mismatched rule file(s): ${missingOrMismatchedTargets.join(", ")}`,
    };
  }

  return {
    ok: true,
    detail: `${getRuleFileDefinitions().length} consolidated rule files present`,
  };
}

async function uninstallMasterPrompt(ctx: Context): Promise<void> {
  const managedActions = getManagedActions(ctx);

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep pre-existing rule files untouched");
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
    const backupPath = buildBackupPath(ctx.cwd, action.target);

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
  detect: detectMasterPrompt,
  install: installMasterPrompt,
  verify: verifyMasterPrompt,
  uninstall: uninstallMasterPrompt,
};
