import { readFile, rm } from "node:fs/promises";
import { CLAUDE_PROBE_SPEC } from "../../adapters/claude-code.js";
import {
  isVersionOlderThan,
  probeAgentInstallation,
} from "../../adapters/version-probe.js";
import type { Context } from "../../core/context.js";
import {
  MAX_READ_FILE_LABEL,
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "../../core/files.js";
import { fingerprintContent } from "../../core/fingerprint.js";
import { resolveHookScriptPath } from "../../core/package-assets.js";
import {
  ensureRepoDirectory,
  resolveInsideRepo,
} from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { printable } from "../../core/untrusted-text.js";
import { recordCreatedDirectories } from "../../core/workspace-footprint.js";
import {
  addArrayEntry,
  readArrayEntries,
  removeArrayEntry,
} from "../../patchers/json-settings-array.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginApplyReport,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  SkippedPluginOperation,
  StagedFile,
} from "../types.js";

const PLUGIN_ID = "delegation-guard";
const SETTINGS_DIRECTORY = ".claude";
const SETTINGS_PATH = `${SETTINGS_DIRECTORY}/settings.json`;
const HOOKS_DIRECTORY = `${SETTINGS_DIRECTORY}/hooks`;
const SCRIPT_NAME = "agemon-delegation-guard.mjs";
export const DELEGATION_GUARD_SCRIPT_PATH = `${HOOKS_DIRECTORY}/${SCRIPT_NAME}`;
const HOOK_TIMEOUT_SECONDS = 5;
const SCRIPT_RESOURCE_ID = "hook-script";
const SETTINGS_RESOURCE_ID = "settings-hooks";
const ACTION_TYPE_HOOK_SCRIPT = "managed-hook-script";
const ACTION_TYPE_SETTINGS_ENTRIES = "managed-settings-entries";
const FIRST_CLI_WITH_SUBAGENT_HOOK_FIELDS = "2.1.251";

interface SettingsArrayEntry {
  path: readonly string[];
  entry: unknown;
}

const GUARD_COMMAND = {
  type: "command",
  command: `node "\${CLAUDE_PROJECT_DIR:-.}/${DELEGATION_GUARD_SCRIPT_PATH}"`,
  timeout: HOOK_TIMEOUT_SECONDS,
};

const GUARD_HOOK_ENTRIES: readonly SettingsArrayEntry[] = [
  {
    path: ["hooks", "SessionStart"],
    entry: { matcher: "startup|clear|fork", hooks: [GUARD_COMMAND] },
  },
  { path: ["hooks", "UserPromptSubmit"], entry: { hooks: [GUARD_COMMAND] } },
  {
    path: ["hooks", "PreToolUse"],
    entry: { matcher: "Read|Grep|Glob|Agent", hooks: [GUARD_COMMAND] },
  },
];

type RepoFileState =
  | { kind: "unusable"; reason: string }
  | { kind: "usable"; contents: string | null };

async function readRepoFileState(
  ctx: Context,
  path: string,
): Promise<RepoFileState> {
  try {
    return {
      kind: "usable",
      contents: await readRegularFileIfExists(
        await resolveInsideRepo(ctx.cwd, path),
      ),
    };
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return {
        kind: "unusable",
        reason: `${path} is a symlink, special file, larger than ${MAX_READ_FILE_LABEL}, or under a symlinked directory; agemon leaves it alone`,
      };
    }
    throw error;
  }
}

async function readSettingsState(ctx: Context): Promise<RepoFileState> {
  const state = await readRepoFileState(ctx, SETTINGS_PATH);
  if (state.kind === "unusable") {
    return state;
  }
  for (const { path } of GUARD_HOOK_ENTRIES) {
    const reading = readArrayEntries(state.contents, path);
    if (reading.kind === "invalid") {
      return {
        kind: "unusable",
        reason: `${SETTINGS_PATH} can't be changed safely because ${reading.reason}; agemon leaves it alone`,
      };
    }
  }
  return state;
}

export function settingsWithDelegationGuardHooks(
  contents: string | null,
): string {
  let current = contents ?? "{}\n";
  for (const { path, entry } of GUARD_HOOK_ENTRIES) {
    const result = addArrayEntry(current, path, entry);
    if (result.kind === "invalid") {
      throw new Error(
        `${SETTINGS_PATH} changed since agemon planned the delegation guard hooks. Re-run 'agemon plan'.`,
      );
    }
    if (result.kind === "changed") {
      current = result.nextContent;
    }
  }
  return current;
}

export async function readBundledDelegationGuardScript(): Promise<string> {
  return readFile(resolveHookScriptPath(SCRIPT_NAME), "utf8");
}

function confirmedEntry(
  ctx: Context,
  resourceId: string,
): LedgerEntry | undefined {
  return ctx.manifest
    .getActions()
    .find(
      (action) =>
        action.plugin === PLUGIN_ID &&
        action.resourceId === resourceId &&
        ctx.manifest.isConfirmed(action),
    );
}

function isAgemonScript(ctx: Context, contents: string): boolean {
  return (
    confirmedEntry(ctx, SCRIPT_RESOURCE_ID)?.fingerprintAfter ===
    fingerprintContent(contents)
  );
}

async function reasonClaudeCodeCannotRunGuard(
  ctx: Context,
): Promise<string | null> {
  const { version } = await probeAgentInstallation(ctx, CLAUDE_PROBE_SPEC);
  if (version === null) {
    return `agemon could not read a Claude Code version, so it can't tell whether hooks can tell subagents apart (that started in ${FIRST_CLI_WITH_SUBAGENT_HOOK_FIELDS}); no guard installed`;
  }
  return isVersionOlderThan(version, FIRST_CLI_WITH_SUBAGENT_HOOK_FIELDS)
    ? `Claude Code ${version} is older than ${FIRST_CLI_WITH_SUBAGENT_HOOK_FIELDS}, where hooks started to tell subagents apart, so the guard would block Explore too; no guard installed`
    : null;
}

function scriptOperation(
  current: string | null,
  bundled: string,
): ProposedOperation {
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: SCRIPT_RESOURCE_ID,
    targetPath: DELEGATION_GUARD_SCRIPT_PATH,
    action: current === null ? "create" : "replace",
    riskClass: "executes",
    requiresConsent: true,
    expectedFingerprint: current === null ? null : fingerprintContent(current),
    preview: {
      kind: "diff",
      text: renderUnifiedDiff(
        current ?? "",
        bundled,
        DELEGATION_GUARD_SCRIPT_PATH,
      ),
    },
  });
}

function settingsOperation(
  contents: string | null,
  nextContents: string,
): ProposedOperation {
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: SETTINGS_RESOURCE_ID,
    targetPath: SETTINGS_PATH,
    action: "merge-key",
    riskClass: "executes",
    requiresConsent: true,
    expectedFingerprint:
      contents === null ? null : fingerprintContent(contents),
    preview: {
      kind: "diff",
      text: renderUnifiedDiff(contents ?? "", nextContents, SETTINGS_PATH),
    },
  });
}

async function planDelegationGuard(ctx: Context): Promise<ProposedOperation[]> {
  const settings = await readSettingsState(ctx);
  const script = await readRepoFileState(ctx, DELEGATION_GUARD_SCRIPT_PATH);
  if (settings.kind === "unusable") {
    ctx.ui.info(`${PLUGIN_ID}: ${settings.reason}`);
    return [];
  }
  if (script.kind === "unusable") {
    ctx.ui.info(`${PLUGIN_ID}: ${script.reason}`);
    return [];
  }
  const bundled = await readBundledDelegationGuardScript();
  if (
    script.contents !== null &&
    script.contents !== bundled &&
    !isAgemonScript(ctx, script.contents)
  ) {
    ctx.ui.info(
      `${PLUGIN_ID}: ${DELEGATION_GUARD_SCRIPT_PATH} exists and agemon did not write it; agemon leaves it alone`,
    );
    return [];
  }
  const nextSettings = settingsWithDelegationGuardHooks(settings.contents);
  const operations = [
    ...(script.contents === bundled
      ? []
      : [scriptOperation(script.contents, bundled)]),
    ...(nextSettings === settings.contents
      ? []
      : [settingsOperation(settings.contents, nextSettings)]),
  ];
  if (operations.length === 0) {
    return [];
  }
  const cliReason = await reasonClaudeCodeCannotRunGuard(ctx);
  if (cliReason !== null) {
    ctx.ui.info(`${PLUGIN_ID}: ${cliReason}`);
    return [];
  }
  return operations;
}

function assertDelegationGuardPerforms(operation: ProposedOperation): void {
  const isScript =
    operation.resourceId === SCRIPT_RESOURCE_ID &&
    operation.targetPath === DELEGATION_GUARD_SCRIPT_PATH &&
    (operation.action === "create" || operation.action === "replace");
  const isSettings =
    operation.resourceId === SETTINGS_RESOURCE_ID &&
    operation.targetPath === SETTINGS_PATH &&
    operation.action === "merge-key";
  if (!isScript && !isSettings) {
    throw new Error(
      `Plan operation ${printable(operation.id)} is not something the delegation-guard capability does (${operation.action} ${printable(operation.targetPath)}).`,
    );
  }
}

async function stagedContentsFor(
  ctx: Context,
  operation: ProposedOperation,
): Promise<StagedFile> {
  if (operation.resourceId === SCRIPT_RESOURCE_ID) {
    return {
      targetPath: DELEGATION_GUARD_SCRIPT_PATH,
      contents: await readBundledDelegationGuardScript(),
      kind: "text",
    };
  }
  const settings = await readRepoFileState(ctx, SETTINGS_PATH);
  if (settings.kind === "unusable") {
    throw new Error(`${SETTINGS_PATH}: ${settings.reason}`);
  }
  return {
    targetPath: SETTINGS_PATH,
    contents: settingsWithDelegationGuardHooks(settings.contents),
    kind: "json",
  };
}

async function materializeDelegationGuard(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<StagedFile[]> {
  operations.forEach(assertDelegationGuardPerforms);
  const staged: StagedFile[] = [];
  for (const operation of operations) {
    staged.push(await stagedContentsFor(ctx, operation));
  }
  return staged;
}

async function writeRecordedFile(
  ctx: Context,
  operation: ProposedOperation,
  contentsAfter: string,
): Promise<void> {
  const isScript = operation.resourceId === SCRIPT_RESOURCE_ID;
  const targetPath = await resolveInsideRepo(ctx.cwd, operation.targetPath);
  const contentsBefore = await readRegularFileIfExists(targetPath);
  await writeFileAtomic(targetPath, contentsAfter);
  const recorded = confirmedEntry(ctx, operation.resourceId);
  if (recorded) {
    await ctx.manifest.removeActionIds([recorded.id]);
  }
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: isScript ? ACTION_TYPE_HOOK_SCRIPT : ACTION_TYPE_SETTINGS_ENTRIES,
    target: operation.targetPath,
    preExisting: recorded?.preExisting ?? contentsBefore !== null,
    resourceId: operation.resourceId,
    ownershipMode: isScript ? "created" : "recorded-key",
    fingerprintBefore:
      contentsBefore === null ? null : fingerprintContent(contentsBefore),
    fingerprintAfter: fingerprintContent(contentsAfter),
    desiredRevision: isScript ? null : JSON.stringify(GUARD_HOOK_ENTRIES),
  });
}

async function applyDelegationGuard(
  ctx: Context,
  operations: ProposedOperation[],
  staged?: StagedFile[],
): Promise<PluginApplyReport> {
  operations.forEach(assertDelegationGuardPerforms);
  const scriptOperation = operations.find(
    (operation) => operation.resourceId === SCRIPT_RESOURCE_ID,
  );
  const settingsOperation = operations.find(
    (operation) => operation.resourceId === SETTINGS_RESOURCE_ID,
  );
  const skipped: SkippedPluginOperation[] = [];
  if (scriptOperation !== undefined) {
    await recordCreatedDirectories(
      ctx,
      await ensureRepoDirectory(ctx.cwd, HOOKS_DIRECTORY),
    );
    await writeRecordedFile(
      ctx,
      scriptOperation,
      staged?.find((file) => file.targetPath === DELEGATION_GUARD_SCRIPT_PATH)
        ?.contents ?? (await readBundledDelegationGuardScript()),
    );
  }
  if (settingsOperation === undefined) {
    return { skipped };
  }
  if (scriptOperation === undefined && !(await hasBundledScript(ctx))) {
    skipped.push({
      operationId: settingsOperation.id,
      reason: `${DELEGATION_GUARD_SCRIPT_PATH} is not being installed, and its hooks would fail on every prompt without it`,
    });
    return { skipped };
  }
  await recordCreatedDirectories(
    ctx,
    await ensureRepoDirectory(ctx.cwd, SETTINGS_DIRECTORY),
  );
  const freshSettings = await stagedContentsFor(ctx, settingsOperation);
  await writeRecordedFile(ctx, settingsOperation, freshSettings.contents);
  return { skipped };
}

async function hasEveryGuardHook(ctx: Context): Promise<boolean> {
  const settings = await readSettingsState(ctx);
  return (
    settings.kind === "usable" &&
    settings.contents !== null &&
    settingsWithDelegationGuardHooks(settings.contents) === settings.contents
  );
}

async function hasBundledScript(ctx: Context): Promise<boolean> {
  const script = await readRepoFileState(ctx, DELEGATION_GUARD_SCRIPT_PATH);
  return (
    script.kind === "usable" &&
    script.contents === (await readBundledDelegationGuardScript())
  );
}

async function detectDelegationGuard(ctx: Context): Promise<PluginPresence> {
  const present =
    (await hasBundledScript(ctx)) && (await hasEveryGuardHook(ctx));
  return {
    present,
    preExisting:
      present && confirmedEntry(ctx, SCRIPT_RESOURCE_ID) === undefined,
  };
}

async function describeDelegationGuardState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const row = (
    state: CapabilityStateRow["state"],
    detail: string,
  ): CapabilityStateRow[] => [
    {
      capabilityId: PLUGIN_ID,
      resourceId: SCRIPT_RESOURCE_ID,
      label: "delegation guard hooks",
      state,
      detail,
    },
  ];
  const settings = await readSettingsState(ctx);
  if (settings.kind === "unusable") {
    return row("unknown", settings.reason);
  }
  const { present, preExisting } = await detectDelegationGuard(ctx);
  if (present) {
    return preExisting
      ? row("present-adopted", "installed, but not by agemon on this machine")
      : row(
          "present-managed",
          `${DELEGATION_GUARD_SCRIPT_PATH}, asked about in each new chat`,
        );
  }
  return confirmedEntry(ctx, SCRIPT_RESOURCE_ID) === undefined
    ? row(
        "absent",
        (await reasonClaudeCodeCannotRunGuard(ctx)) ??
          `run 'agemon add ${PLUGIN_ID}' to install it`,
      )
    : row("present-modified", "the script or its hooks changed; run agemon");
}

async function verifyDelegationGuard(
  ctx: Context,
): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }
  if (confirmedEntry(ctx, SCRIPT_RESOURCE_ID) === undefined) {
    return { ok: true, detail: "no guard installed by agemon" };
  }
  return (await detectDelegationGuard(ctx)).present
    ? {
        ok: true,
        detail: `${DELEGATION_GUARD_SCRIPT_PATH} and its hooks in ${SETTINGS_PATH}`,
      }
    : {
        ok: true,
        attention: `the delegation guard script or its hooks are missing or changed; run agemon to restore them`,
      };
}

async function removeRecordedScript(
  ctx: Context,
  entry: LedgerEntry,
): Promise<void> {
  const script = await readRepoFileState(ctx, DELEGATION_GUARD_SCRIPT_PATH);
  if (script.kind === "unusable") {
    ctx.ui.info(`manual cleanup needed: ${script.reason}`);
  } else if (script.contents === null) {
    return;
  } else if (fingerprintContent(script.contents) !== entry.fingerprintAfter) {
    ctx.ui.info(
      `Keeping ${DELEGATION_GUARD_SCRIPT_PATH}: it changed since agemon wrote it.`,
    );
  } else {
    await rm(await resolveInsideRepo(ctx.cwd, DELEGATION_GUARD_SCRIPT_PATH), {
      force: true,
    });
  }
}

async function removeRecordedHooks(
  ctx: Context,
  entry: LedgerEntry,
  recordedEntries: SettingsArrayEntry[],
): Promise<void> {
  const manualCleanup = `manual cleanup needed: remove the delegation guard hooks from ${SETTINGS_PATH} by hand`;
  const settings = await readRepoFileState(ctx, SETTINGS_PATH);
  if (settings.kind === "unusable") {
    ctx.ui.info(`${manualCleanup}; it is not a regular file`);
    return;
  }
  if (settings.contents === null) {
    return;
  }
  let contents = settings.contents;
  let settingsAreEmpty = false;
  for (const { path, entry: hookEntry } of recordedEntries) {
    const result = removeArrayEntry(contents, path, hookEntry);
    if (result.kind === "invalid") {
      ctx.ui.info(`${manualCleanup}; ${result.reason}`);
      return;
    }
    if (result.kind === "removed") {
      contents = result.nextContent;
      settingsAreEmpty = result.settingsAreEmpty;
    }
  }
  if (contents === settings.contents) {
    return;
  }
  const targetPath = await resolveInsideRepo(ctx.cwd, SETTINGS_PATH);
  if (settingsAreEmpty && !entry.preExisting) {
    await rm(targetPath, { force: true });
  } else {
    await writeFileAtomic(targetPath, contents);
  }
}

function isDelegationGuardEntry(entry: LedgerEntry): boolean {
  return (
    (entry.type === ACTION_TYPE_HOOK_SCRIPT &&
      entry.target === DELEGATION_GUARD_SCRIPT_PATH &&
      entry.resourceId === SCRIPT_RESOURCE_ID) ||
    (entry.type === ACTION_TYPE_SETTINGS_ENTRIES &&
      entry.target === SETTINGS_PATH &&
      entry.resourceId === SETTINGS_RESOURCE_ID &&
      entry.desiredRevision !== null)
  );
}

async function revertDelegationGuard(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (!isDelegationGuardEntry(entry)) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: the delegation-guard capability does not manage it`,
      );
    } else if (!ctx.manifest.isConfirmed(entry)) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: agemon did not write it on this machine`,
      );
    } else if (ctx.dryRun) {
      ctx.ui.info(`Would remove the delegation guard from ${entry.target}`);
    } else if (entry.type === ACTION_TYPE_HOOK_SCRIPT) {
      await removeRecordedScript(ctx, entry);
    } else {
      await removeRecordedHooks(
        ctx,
        entry,
        JSON.parse(entry.desiredRevision ?? "[]"),
      );
    }
  }
}

async function uninstallDelegationGuard(ctx: Context): Promise<void> {
  await revertDelegationGuard(
    ctx,
    ctx.manifest.getActions().filter((action) => action.plugin === PLUGIN_ID),
  );
}

export const delegationGuardPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  summary:
    "opt-in: asks in each new chat whether to cap main-thread searches per prompt and steer Claude to the Haiku Explore agent",
  optIn: true,
  riskClass: "executes",
  detect: detectDelegationGuard,
  describeState: describeDelegationGuardState,
  plan: planDelegationGuard,
  materialize: materializeDelegationGuard,
  apply: applyDelegationGuard,
  verify: verifyDelegationGuard,
  revert: revertDelegationGuard,
  uninstall: uninstallDelegationGuard,
};
