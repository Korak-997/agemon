import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { Context } from "../../core/context.js";
import { errorMessage } from "../../core/error-message.js";
import { RefusedFileError } from "../../core/files.js";
import { isSameOrInside } from "../../core/repo-paths.js";
import type {
  LedgerEntry,
  RecordManifestActionInput,
} from "../../core/state-manifest.js";
import { printable } from "../../core/untrusted-text.js";
import {
  containsHomeDirectory,
  isUsableAbsolutePath,
} from "../../platform/home.js";
import type { RegisterAutostartResult } from "../../platform/service-manager/index.js";
import { AGEMON_DAEMON_UNIT_PATTERN } from "../../platform/service-manager/unit-files.js";
import { crgUnitEnvironment, resolveCrgHome } from "../crg/environment.js";
import { BROKEN_PIPX_VENV_HINT, locateCodeReviewGraph } from "../crg/locate.js";
import { CODE_REVIEW_GRAPH_PACKAGE_SPEC } from "../pins.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
} from "../types.js";

const PLUGIN_ID = "daemon";
const CRG_COMMAND = "code-review-graph";
const UNIT_NAME_PREFIX = "agemon-crg-daemon";
const UNIT_NAME_MAX_SLUG_LENGTH = 40;
const UNIT_NAME_HASH_LENGTH = 8;
const GRAPH_DIRECTORY = ".code-review-graph";
const CHARACTERS_SYSTEMD_CANNOT_EXECUTE = /[\\"']/;

const ACTION_TYPE_REGISTERED_SERVICE = "registered-service";
const ACTION_TYPE_ENABLED_LINGER = "enabled-linger";
const ACTION_TYPE_HARDENING_PROFILE = "hardening-profile";
const SERVICE_UNIT_RESOURCE_PREFIX = "service-unit:";

function slugifyForUnitName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "repo").slice(0, UNIT_NAME_MAX_SLUG_LENGTH);
}

async function resolveUnitName(ctx: Context): Promise<string> {
  const repoRoot = await realpath(ctx.cwd);
  const repoHash = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, UNIT_NAME_HASH_LENGTH);
  return `${UNIT_NAME_PREFIX}-${slugifyForUnitName(basename(repoRoot))}-${repoHash}.service`;
}

interface RecordedUnit {
  entry: LedgerEntry;
  unitName: string;
}

function isRecordedRegistration(entry: LedgerEntry): boolean {
  return (
    entry.type === ACTION_TYPE_REGISTERED_SERVICE && entry.preExisting === false
  );
}

function recordedUnits(entries: LedgerEntry[]): RecordedUnit[] {
  return entries
    .filter(isRecordedRegistration)
    .map((entry) => ({ entry, unitName: recordedUnitName(entry) }))
    .filter((unit) => AGEMON_DAEMON_UNIT_PATTERN.test(unit.unitName));
}

function reportUnmanagedUnitNames(ctx: Context, entries: LedgerEntry[]): void {
  for (const entry of entries.filter(isRecordedRegistration)) {
    const unitName = recordedUnitName(entry);
    if (!AGEMON_DAEMON_UNIT_PATTERN.test(unitName)) {
      ctx.ui.info(
        `ignoring ledger entry for ${printable(unitName)}: daemon does not manage that unit`,
      );
    }
  }
}

function findStaleRecordedUnits(
  ctx: Context,
  expectedUnitName: string,
): RecordedUnit[] {
  return recordedUnits(getPluginActions(ctx)).filter(
    (unit) => unit.unitName !== expectedUnitName,
  );
}

async function existingDirectoryRealpath(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

type UnitOwnership =
  | { kind: "no-unit-file" }
  | { kind: "this-repo" }
  | { kind: "other"; owner: string };

const HASHED_UNIT_NAME_SUFFIX = /-[0-9a-f]{8}\.service$/;

async function classifyRecordedUnit(
  ctx: Context,
  unit: RecordedUnit,
  repoRoot: string,
): Promise<UnitOwnership> {
  let workingDirectory: string | null;
  try {
    workingDirectory = await ctx.serviceManager.readUnitWorkingDirectory(
      unit.unitName,
    );
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return { kind: "other", owner: "an unreadable unit file" };
    }
    throw error;
  }
  if (workingDirectory === null) {
    return { kind: "no-unit-file" };
  }
  if (!isAbsolute(workingDirectory)) {
    return {
      kind: "other",
      owner: `a non-absolute WorkingDirectory (${workingDirectory})`,
    };
  }

  const ownsSubdirectories = !HASHED_UNIT_NAME_SUFFIX.test(unit.unitName);
  const candidates = new Set([
    workingDirectory,
    workingDirectory.replaceAll("%%", "%"),
  ]);
  let foreignDirectory: string | null = null;
  for (const candidate of candidates) {
    const real = await existingDirectoryRealpath(candidate);
    if (real === null) {
      continue;
    }
    const owned = ownsSubdirectories
      ? isSameOrInside(real, repoRoot)
      : real === repoRoot;
    if (owned) {
      return { kind: "this-repo" };
    }
    foreignDirectory = real;
  }
  return foreignDirectory === null
    ? { kind: "this-repo" }
    : { kind: "other", owner: foreignDirectory };
}

function describeKeptUnit(ctx: Context, unitName: string, owner: string): void {
  ctx.ui.info(
    `${ctx.dryRun ? "Would keep" : "Keeping"} user service ${unitName}: it now runs for ${printable(owner)}`,
  );
}

async function migrateStaleUnit(
  ctx: Context,
  staleUnit: RecordedUnit,
  repoRoot: string,
): Promise<void> {
  const ownership = await classifyRecordedUnit(ctx, staleUnit, repoRoot);
  if (ownership.kind === "other") {
    describeKeptUnit(ctx, staleUnit.unitName, ownership.owner);
  } else {
    await ctx.serviceManager.unregisterAutostart({
      unitName: staleUnit.unitName,
      disableLinger: false,
    });
  }
  await ctx.manifest.removeActionIds([staleUnit.entry.id]);
}

type HardeningProfile = "strict" | "compat";

interface UnitPaths {
  repoRoot: string;
  crgBinaryPath: string;
  crgHome: string;
}

interface HardeningChoice {
  profiles: HardeningProfile[];
  compatReason: string | null;
}

const STRICT_FAILED_NOTE =
  "if crg's registry stores this repo's graph outside the repository, strict can't write it";

function escapeSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteUnitValue(value: string): string {
  const escaped = escapeSpecifiers(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function quoteExecArgument(value: string): string {
  return quoteUnitValue(value).replaceAll("$", () => "$$");
}

function assertUsableInUnit(label: string, path: string): void {
  if (!isUsableAbsolutePath(path) || path.endsWith("\\")) {
    throw new Error(
      `Can't register the daemon: the ${label} '${printable(path)}' must be an absolute path without control characters, surrounding spaces or a trailing backslash.`,
    );
  }
}

async function resolveCrgBinaryPath(ctx: Context): Promise<string> {
  const location = await locateCodeReviewGraph(ctx);
  if (location.status === "broken-venv") {
    throw new Error(`${CRG_COMMAND}'s ${BROKEN_PIPX_VENV_HINT}`);
  }
  if (location.status !== "found") {
    throw new Error(
      `Unable to resolve an absolute path for '${CRG_COMMAND}' on PATH; ` +
        `is it installed (e.g. via 'pipx install ${CODE_REVIEW_GRAPH_PACKAGE_SPEC}')?`,
    );
  }
  if (CHARACTERS_SYSTEMD_CANNOT_EXECUTE.test(location.binaryPath)) {
    throw new Error(
      `code-review-graph is installed at ${printable(location.binaryPath)}, which systemd can't run; reinstall it under a path without \\ " or '`,
    );
  }
  return location.binaryPath;
}

async function assertGraphIsARealDirectory(repoRoot: string): Promise<void> {
  let graph: Awaited<ReturnType<typeof lstat>>;
  try {
    graph = await lstat(join(repoRoot, GRAPH_DIRECTORY));
  } catch {
    return;
  }
  if (!graph.isDirectory()) {
    throw new Error(
      `Can't register the daemon: ${GRAPH_DIRECTORY} in the repository is not a real directory, so the daemon would write through it. Remove it and run agemon again.`,
    );
  }
}

async function resolveUnitPaths(ctx: Context): Promise<UnitPaths> {
  const paths: UnitPaths = {
    repoRoot: await realpath(ctx.cwd),
    crgBinaryPath: await resolveCrgBinaryPath(ctx),
    crgHome: resolveCrgHome(),
  };
  assertUsableInUnit("repository path", paths.repoRoot);
  assertUsableInUnit("code-review-graph path", paths.crgBinaryPath);
  assertUsableInUnit("code-review-graph home", paths.crgHome);
  await assertGraphIsARealDirectory(paths.repoRoot);
  return paths;
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function chooseHardening(paths: UnitPaths): Promise<HardeningChoice> {
  if (process.env.AGEMON_DAEMON_HARDENING === "compat") {
    return {
      profiles: ["compat"],
      compatReason: "AGEMON_DAEMON_HARDENING=compat",
    };
  }
  if (await containsHomeDirectory(paths.repoRoot)) {
    return {
      profiles: ["compat"],
      compatReason: "the repository is or contains your home directory",
    };
  }
  if (await containsHomeDirectory(await realpathOrSelf(paths.crgHome))) {
    return {
      profiles: ["compat"],
      compatReason: "crg's home is or contains your home directory",
    };
  }
  return { profiles: ["strict", "compat"], compatReason: null };
}

function describeHardening(
  registration: RegisterAutostartResult,
  choice: HardeningChoice,
): string {
  if (registration.attemptLabel === "strict") {
    return "daemon hardening: strict";
  }
  const reason =
    choice.compatReason ??
    `the strict unit did not start (${printable(registration.failedAttempts.join("; "))}); ${STRICT_FAILED_NOTE}`;
  return `daemon hardening: compat (${reason})`;
}

function getHardeningDirectives(
  profile: HardeningProfile,
  paths: UnitPaths,
): string[] {
  if (profile === "compat") {
    return ["NoNewPrivileges=yes", "RestrictSUIDSGID=yes"];
  }

  return [
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "ProtectSystem=full",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
    `ReadWritePaths=${quoteUnitValue(paths.repoRoot)} ${quoteUnitValue(`-${paths.crgHome}`)}`,
    `ReadOnlyPaths=${quoteUnitValue(`-${join(paths.repoRoot, ".git")}`)}`,
  ];
}

function buildUnitContents(
  paths: UnitPaths,
  profile: HardeningProfile,
): string {
  const environment = crgUnitEnvironment();
  return [
    "[Unit]",
    "Description=agemon code-review-graph daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeSpecifiers(paths.repoRoot)}`,
    `ExecStart=${quoteUnitValue(paths.crgBinaryPath)} ${quoteExecArgument("watch")}`,
    ...Object.entries(environment.set).map(
      ([name, value]) => `Environment=${quoteUnitValue(`${name}=${value}`)}`,
    ),
    `UnsetEnvironment=${environment.unset.join(" ")}`,
    ...getHardeningDirectives(profile, paths),
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function hasManagedServiceRegistration(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_REGISTERED_SERVICE &&
      action.preExisting === false,
  );
}

async function detectDaemon(ctx: Context): Promise<PluginPresence> {
  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
  if (!status.active || findStaleRecordedUnits(ctx, unitName).length > 0) {
    return { present: false, preExisting: false };
  }

  if (hasManagedServiceRegistration(ctx)) {
    return { present: true, preExisting: false };
  }

  return { present: true, preExisting: true };
}

async function describeDaemonState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
  const resourceId = `${SERVICE_UNIT_RESOURCE_PREFIX}${unitName}`;

  if (findStaleRecordedUnits(ctx, unitName).length > 0) {
    return [
      {
        capabilityId: PLUGIN_ID,
        resourceId,
        label: unitName,
        state: "present-managed",
        detail: "registered under an old name — run 'agemon' to migrate",
      },
    ];
  }

  if (!status.active) {
    return [
      {
        capabilityId: PLUGIN_ID,
        resourceId,
        label: unitName,
        state: "absent",
        detail: null,
      },
    ];
  }

  const managed = hasManagedServiceRegistration(ctx);
  return [
    {
      capabilityId: PLUGIN_ID,
      resourceId,
      label: unitName,
      state: managed ? "present-managed" : "present-adopted",
      detail: managed ? "registered by agemon" : "pre-existing unit",
    },
  ];
}

async function planDaemon(ctx: Context): Promise<ProposedOperation[]> {
  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
  const staleUnitNames = findStaleRecordedUnits(ctx, unitName).map(
    (unit) => unit.unitName,
  );
  if (status.active && staleUnitNames.length === 0) {
    return [];
  }

  const replaces =
    staleUnitNames.length === 0
      ? ""
      : `; replaces ${staleUnitNames.join(", ")}`;
  return [
    describeOperation({
      capabilityId: PLUGIN_ID,
      resourceId: `${SERVICE_UNIT_RESOURCE_PREFIX}${unitName}`,
      targetPath: unitName,
      action: "register-service",
      riskClass: "executes",
      requiresConsent: true,
      preview: {
        kind: "note",
        text: `register systemd --user unit ${unitName} to keep the code graph fresh${replaces}`,
      },
    }),
  ];
}

async function installDaemon(ctx: Context): Promise<void> {
  const unitName = await resolveUnitName(ctx);

  const staleUnits = findStaleRecordedUnits(ctx, unitName);
  if (ctx.dryRun) {
    const replaces =
      staleUnits.length === 0
        ? ""
        : ` and replace ${staleUnits.map((unit) => unit.unitName).join(", ")}`;
    ctx.ui.info(`Would register user service ${unitName}${replaces}`);
    ctx.ui.info("Would enable user linger when not already enabled");
    return;
  }

  const alreadyRegistered =
    recordedUnits(getPluginActions(ctx)).some(
      (unit) => unit.unitName === unitName,
    ) && (await ctx.serviceManager.isActive(unitName)).active;
  if (!alreadyRegistered) {
    await registerDaemon(ctx, unitName);
  }
  const repoRoot = await realpath(ctx.cwd);
  for (const staleUnit of staleUnits) {
    await migrateStaleUnit(ctx, staleUnit, repoRoot);
  }
}

async function registerDaemon(ctx: Context, unitName: string): Promise<void> {
  const paths = await resolveUnitPaths(ctx);
  const hardening = await chooseHardening(paths);
  const registration = await ctx.serviceManager.registerAutostart({
    unitName,
    attempts: hardening.profiles.map((profile) => ({
      label: profile,
      unitContents: buildUnitContents(paths, profile),
    })),
  });
  ctx.ui.info(describeHardening(registration, hardening));

  try {
    await recordRegistration(ctx, unitName, registration);
  } catch (error) {
    try {
      await ctx.serviceManager.unregisterAutostart({
        unitName,
        disableLinger: registration.lingerEnabledByAgemon,
      });
    } catch (cleanupError) {
      const manualCleanup = [
        `systemctl --user disable --now ${unitName}`,
        `rm '${registration.unitPath}'`,
        "systemctl --user daemon-reload",
        ...(registration.lingerEnabledByAgemon
          ? ["loginctl disable-linger"]
          : []),
      ];
      throw new Error(
        `${errorMessage(error)}; removing ${unitName} again also failed (${errorMessage(cleanupError)}). Run these yourself: ${manualCleanup.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function recordedUnitName(entry: LedgerEntry): string {
  return entry.resourceId?.startsWith(SERVICE_UNIT_RESOURCE_PREFIX)
    ? entry.resourceId.slice(SERVICE_UNIT_RESOURCE_PREFIX.length)
    : basename(entry.target);
}

async function recordRegistration(
  ctx: Context,
  unitName: string,
  registration: RegisterAutostartResult,
): Promise<void> {
  const supersededIds = getPluginActions(ctx)
    .filter(
      (action) =>
        action.type === ACTION_TYPE_HARDENING_PROFILE ||
        (action.type === ACTION_TYPE_REGISTERED_SERVICE &&
          recordedUnitName(action) === unitName),
    )
    .map((action) => action.id);

  const idsBeforeRecording = new Set(
    getPluginActions(ctx).map((action) => action.id),
  );
  const record = async (
    input: Omit<RecordManifestActionInput, "plugin" | "preExisting">,
  ): Promise<void> => {
    await ctx.manifest.recordAction({
      ...input,
      plugin: PLUGIN_ID,
      preExisting: false,
    });
  };

  try {
    await record({
      type: ACTION_TYPE_REGISTERED_SERVICE,
      target: registration.unitPath,
      resourceId: `${SERVICE_UNIT_RESOURCE_PREFIX}${unitName}`,
    });
    if (registration.lingerEnabledByAgemon) {
      await record({
        type: ACTION_TYPE_ENABLED_LINGER,
        target: process.env.USER ?? "current-user",
      });
    }
    await record({
      type: ACTION_TYPE_HARDENING_PROFILE,
      target: registration.attemptLabel,
    });
    await ctx.manifest.removeActionIds(supersededIds);
  } catch (error) {
    const recordedIds = getPluginActions(ctx)
      .map((action) => action.id)
      .filter((id) => !idsBeforeRecording.has(id));
    await ctx.manifest.removeActionIds(recordedIds).catch(() => {});
    throw error;
  }
}

async function verifyDaemon(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const unitName = await resolveUnitName(ctx);
  const status = await ctx.serviceManager.isActive(unitName);
  if (!status.active) {
    return { ok: false, detail: `${unitName} is not active` };
  }

  return { ok: true, detail: `${unitName} active` };
}

function entriesEnabledLingerByAgemon(entries: LedgerEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === ACTION_TYPE_ENABLED_LINGER && entry.preExisting === false,
  );
}

async function revertDaemon(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  reportUnmanagedUnitNames(ctx, entries);
  const units = recordedUnits(entries);
  const repoRoot = await realpath(ctx.cwd);
  const removableUnits: RecordedUnit[] = [];
  let removesAnExistingUnit = false;
  for (const unit of units) {
    const ownership = await classifyRecordedUnit(ctx, unit, repoRoot);
    if (ownership.kind === "other") {
      describeKeptUnit(ctx, unit.unitName, ownership.owner);
    } else {
      removableUnits.push(unit);
      removesAnExistingUnit ||= ownership.kind === "this-repo";
    }
  }
  const disableLinger =
    removesAnExistingUnit && entriesEnabledLingerByAgemon(entries);

  if (ctx.dryRun) {
    for (const unit of removableUnits) {
      ctx.ui.info(`Would unregister user service ${unit.unitName}`);
    }
    if (disableLinger) {
      ctx.ui.info(
        "Would disable user linger because agemon enabled it, unless another agemon daemon still needs it",
      );
    }
    if (units.length === 0) {
      ctx.ui.info(
        "Would keep the pre-existing daemon unit (agemon did not register it)",
      );
    }
    return;
  }

  for (const [index, unit] of removableUnits.entries()) {
    const { lingerKeptFor } = await ctx.serviceManager.unregisterAutostart({
      unitName: unit.unitName,
      disableLinger: disableLinger && index === removableUnits.length - 1,
    });
    if (lingerKeptFor !== null) {
      ctx.ui.info(
        `Keeping user linger: another agemon daemon (${lingerKeptFor}) still needs it`,
      );
    }
  }
}

async function uninstallDaemon(ctx: Context): Promise<void> {
  await revertDaemon(ctx, getPluginActions(ctx));
}

export const daemonPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  dependsOn: ["crg"],
  riskClass: "executes",
  detect: detectDaemon,
  describeState: describeDaemonState,
  plan: planDaemon,
  install: installDaemon,
  verify: verifyDaemon,
  revert: revertDaemon,
  uninstall: uninstallDaemon,
};
