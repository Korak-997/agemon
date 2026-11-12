import { rm } from "node:fs/promises";
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
import {
  ensureRepoDirectory,
  resolveInsideRepo,
} from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { renderUnifiedDiff } from "../../core/text-diff.js";
import { printable } from "../../core/untrusted-text.js";
import { recordCreatedDirectories } from "../../core/workspace-footprint.js";
import {
  type EnvKeyReading,
  readEnvKey,
  removeEnvKey,
  setEnvKey,
} from "../../patchers/json-settings-key.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  StagedFile,
} from "../types.js";

const PLUGIN_ID = "subagent-default";
const SETTINGS_DIRECTORY = ".claude";
const SETTINGS_PATH = `${SETTINGS_DIRECTORY}/settings.json`;
const SUBAGENT_MODEL_KEY = "CLAUDE_CODE_SUBAGENT_MODEL";
const DEFAULT_SUBAGENT_MODEL = "sonnet";
const RESOURCE_ID = `settings-key:env.${SUBAGENT_MODEL_KEY}`;
const ACTION_TYPE_MANAGED_SETTINGS_KEY = "managed-settings-key";
const FIRST_CLI_WHERE_PINS_OUTRANK_THE_DEFAULT = "2.1.251";

type SettingsState =
  | { kind: "unusable"; reason: string }
  | {
      kind: "usable";
      contents: string | null;
      reading: Exclude<EnvKeyReading, { kind: "invalid" }>;
    };

async function readSettingsContents(ctx: Context): Promise<string | null> {
  return readRegularFileIfExists(
    await resolveInsideRepo(ctx.cwd, SETTINGS_PATH),
  );
}

async function readSettingsState(ctx: Context): Promise<SettingsState> {
  let contents: string | null;
  try {
    contents = await readSettingsContents(ctx);
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return {
        kind: "unusable",
        reason: `${SETTINGS_PATH} is a symlink, special file, larger than ${MAX_READ_FILE_LABEL}, or under a symlinked directory; agemon leaves it alone`,
      };
    }
    throw error;
  }
  const reading = readEnvKey(contents, SUBAGENT_MODEL_KEY);
  return reading.kind === "invalid"
    ? {
        kind: "unusable",
        reason: `${SETTINGS_PATH} can't be changed safely because ${reading.reason}; agemon leaves it alone`,
      }
    : { kind: "usable", contents, reading };
}

async function reasonClaudeCodeCannotTakeDefault(
  ctx: Context,
): Promise<string | null> {
  const { version } = await probeAgentInstallation(ctx, CLAUDE_PROBE_SPEC);
  if (version === null) {
    return `agemon could not read a Claude Code version, so it can't tell whether a default subagent model would override pinned ones (that stopped in ${FIRST_CLI_WHERE_PINS_OUTRANK_THE_DEFAULT}); no default written`;
  }
  return isVersionOlderThan(version, FIRST_CLI_WHERE_PINS_OUTRANK_THE_DEFAULT)
    ? `Claude Code ${version} is older than ${FIRST_CLI_WHERE_PINS_OUTRANK_THE_DEFAULT}, where a default subagent model would override pinned ones; no default written`
    : null;
}

function settingsWithDefault(contents: string | null): string {
  const result = setEnvKey(
    contents,
    SUBAGENT_MODEL_KEY,
    DEFAULT_SUBAGENT_MODEL,
  );
  if (result.kind !== "changed") {
    throw new Error(
      `${SETTINGS_PATH} changed since agemon planned to set ${SUBAGENT_MODEL_KEY}. Re-run 'agemon plan'.`,
    );
  }
  return result.nextContent;
}

async function planSubagentDefault(ctx: Context): Promise<ProposedOperation[]> {
  const settings = await readSettingsState(ctx);
  if (settings.kind === "unusable") {
    ctx.ui.info(`${PLUGIN_ID}: ${settings.reason}`);
    return [];
  }
  if (settings.reading.kind === "set") {
    return [];
  }
  const cliReason = await reasonClaudeCodeCannotTakeDefault(ctx);
  if (cliReason !== null) {
    ctx.ui.info(`${PLUGIN_ID}: ${cliReason}`);
    return [];
  }
  return [
    describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: RESOURCE_ID,
      targetPath: SETTINGS_PATH,
      action: "merge-key",
      riskClass: "writes-config",
      requiresConsent: true,
      expectedFingerprint:
        settings.contents === null
          ? null
          : fingerprintContent(settings.contents),
      preview: {
        kind: "diff",
        text: renderUnifiedDiff(
          settings.contents ?? "",
          settingsWithDefault(settings.contents),
          SETTINGS_PATH,
        ),
      },
    }),
  ];
}

function assertSubagentDefaultPerforms(operation: ProposedOperation): void {
  if (
    operation.resourceId !== RESOURCE_ID ||
    operation.targetPath !== SETTINGS_PATH ||
    operation.action !== "merge-key"
  ) {
    throw new Error(
      `Plan operation ${printable(operation.id)} is not something the subagent-default capability does (${operation.action} ${printable(operation.targetPath)}).`,
    );
  }
}

async function materializeSubagentDefault(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<StagedFile[]> {
  operations.forEach(assertSubagentDefaultPerforms);
  if (operations.length === 0) {
    return [];
  }
  return [
    {
      targetPath: SETTINGS_PATH,
      contents: settingsWithDefault(await readSettingsContents(ctx)),
      kind: "json",
    },
  ];
}

function confirmedEntry(ctx: Context): LedgerEntry | undefined {
  return ctx.manifest
    .getActions()
    .find(
      (action) =>
        action.plugin === PLUGIN_ID && ctx.manifest.isConfirmed(action),
    );
}

async function applySubagentDefault(
  ctx: Context,
  operations: ProposedOperation[],
  staged?: StagedFile[],
): Promise<undefined> {
  operations.forEach(assertSubagentDefaultPerforms);
  if (operations.length === 0) {
    return undefined;
  }
  await recordCreatedDirectories(
    ctx,
    await ensureRepoDirectory(ctx.cwd, SETTINGS_DIRECTORY),
  );
  const contentsBefore = await readSettingsContents(ctx);
  const contentsAfter =
    staged?.find((file) => file.targetPath === SETTINGS_PATH)?.contents ??
    settingsWithDefault(contentsBefore);
  await writeFileAtomic(
    await resolveInsideRepo(ctx.cwd, SETTINGS_PATH),
    contentsAfter,
  );
  const recorded = confirmedEntry(ctx);
  if (recorded) {
    await ctx.manifest.removeActionIds([recorded.id]);
  }
  await ctx.manifest.recordAction({
    plugin: PLUGIN_ID,
    type: ACTION_TYPE_MANAGED_SETTINGS_KEY,
    target: SETTINGS_PATH,
    preExisting: recorded?.preExisting ?? contentsBefore !== null,
    resourceId: RESOURCE_ID,
    ownershipMode: "recorded-key",
    fingerprintBefore:
      contentsBefore === null ? null : fingerprintContent(contentsBefore),
    fingerprintAfter: fingerprintContent(contentsAfter),
    desiredRevision: DEFAULT_SUBAGENT_MODEL,
  });
  return undefined;
}

async function detectSubagentDefault(ctx: Context): Promise<PluginPresence> {
  const settings = await readSettingsState(ctx);
  const present = settings.kind === "usable" && settings.reading.kind === "set";
  return { present, preExisting: present && confirmedEntry(ctx) === undefined };
}

async function describeSubagentDefaultState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const row = (
    state: CapabilityStateRow["state"],
    detail: string,
  ): CapabilityStateRow[] => [
    {
      capabilityId: PLUGIN_ID,
      resourceId: RESOURCE_ID,
      label: `env.${SUBAGENT_MODEL_KEY}`,
      state,
      detail,
    },
  ];
  const settings = await readSettingsState(ctx);
  if (settings.kind === "unusable") {
    return row("unknown", settings.reason);
  }
  if (settings.reading.kind === "absent") {
    return row(
      "absent",
      (await reasonClaudeCodeCannotTakeDefault(ctx)) ?? "run agemon to set it",
    );
  }
  const { value } = settings.reading;
  if (confirmedEntry(ctx)?.desiredRevision === value) {
    return row("present-managed", `${SETTINGS_PATH}: ${printable(value)}`);
  }
  return value === DEFAULT_SUBAGENT_MODEL
    ? row(
        "present-adopted",
        `already ${value} and not set by agemon on this machine; nuke leaves it`,
      )
    : row(
        "present-modified",
        `set to ${printable(value)}; that value is yours, and agemon leaves it`,
      );
}

async function verifySubagentDefault(
  ctx: Context,
): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }
  if (confirmedEntry(ctx) === undefined) {
    return { ok: true, detail: "no default set by agemon" };
  }
  const settings = await readSettingsState(ctx);
  if (settings.kind === "unusable") {
    return { ok: true, attention: settings.reason };
  }
  return settings.reading.kind === "absent"
    ? {
        ok: true,
        attention: `${SUBAGENT_MODEL_KEY} is recorded in the ledger but missing from ${SETTINGS_PATH}; run agemon to set it again`,
      }
    : { ok: true, detail: `${SUBAGENT_MODEL_KEY} in ${SETTINGS_PATH}` };
}

function isSubagentDefaultEntry(entry: LedgerEntry): boolean {
  return (
    entry.type === ACTION_TYPE_MANAGED_SETTINGS_KEY &&
    entry.target === SETTINGS_PATH &&
    entry.resourceId === RESOURCE_ID
  );
}

async function removeRecordedKey(
  ctx: Context,
  entry: LedgerEntry,
  recordedValue: string,
): Promise<void> {
  const manualCleanup = `manual cleanup needed: remove ${SUBAGENT_MODEL_KEY} from ${SETTINGS_PATH} by hand`;
  let contents: string | null;
  try {
    contents = await readSettingsContents(ctx);
  } catch (error) {
    if (error instanceof RefusedFileError) {
      ctx.ui.info(`${manualCleanup}; it is not a regular file`);
      return;
    }
    throw error;
  }
  if (contents === null) {
    return;
  }
  const result = removeEnvKey(contents, SUBAGENT_MODEL_KEY, recordedValue);
  if (result.kind === "invalid") {
    ctx.ui.info(`${manualCleanup}; ${result.reason}`);
  } else if (result.kind === "conflict") {
    ctx.ui.info(
      `Keeping ${SUBAGENT_MODEL_KEY} in ${SETTINGS_PATH}: it is now ${printable(result.currentValue)}, not the value agemon set.`,
    );
  } else if (result.kind === "removed") {
    const targetPath = await resolveInsideRepo(ctx.cwd, SETTINGS_PATH);
    if (result.settingsAreEmpty && !entry.preExisting) {
      await rm(targetPath, { force: true });
    } else {
      await writeFileAtomic(targetPath, result.nextContent);
    }
  }
}

async function revertSubagentDefault(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (!isSubagentDefaultEntry(entry) || entry.desiredRevision === null) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: the subagent-default capability does not manage it`,
      );
    } else if (!ctx.manifest.isConfirmed(entry)) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(entry.target)}: agemon did not write it on this machine`,
      );
    } else if (ctx.dryRun) {
      ctx.ui.info(`Would remove ${SUBAGENT_MODEL_KEY} from ${SETTINGS_PATH}`);
    } else {
      await removeRecordedKey(ctx, entry, entry.desiredRevision);
    }
  }
}

async function uninstallSubagentDefault(ctx: Context): Promise<void> {
  await revertSubagentDefault(
    ctx,
    ctx.manifest.getActions().filter((action) => action.plugin === PLUGIN_ID),
  );
}

export const subagentDefaultPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  summary: `sets ${DEFAULT_SUBAGENT_MODEL} as the fallback model for Claude Code subagents, used only when Claude passes no model and the agent file names none, in the team's ${SETTINGS_PATH}`,
  riskClass: "writes-config",
  detect: detectSubagentDefault,
  describeState: describeSubagentDefaultState,
  plan: planSubagentDefault,
  materialize: materializeSubagentDefault,
  apply: applySubagentDefault,
  verify: verifySubagentDefault,
  revert: revertSubagentDefault,
  uninstall: uninstallSubagentDefault,
};
