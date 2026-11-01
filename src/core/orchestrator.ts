import { access, rm } from "node:fs/promises";
import { relative } from "node:path";
import { discoverRepository } from "../inspect/discover.js";
import { redactSecretsInText } from "../inspect/redact.js";
import { verifyManagedState } from "../inspect/status.js";
import { CORE_CAPABILITY_IDS } from "../plugins/index.js";
import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import { renderPlan } from "../ui/plan-view.js";
import { renderRunSummary } from "../ui/summary.js";
import {
  ApplyRollbackError,
  applyPlan,
  FILE_TARGETING_ACTIONS,
} from "./apply.js";
import { assertNoInterruptedApply } from "./apply-journal.js";
import { resolveConfigPath, writeConfig } from "./config.js";
import type { ConflictResolution, SkippedOperation } from "./consent.js";
import { buildConsentGates, useSharedOperations } from "./consent.js";
import type { Context } from "./context.js";
import {
  computePlanId,
  type Plan,
  planContentFingerprint,
  resolveDesiredStateHash,
  writePlan,
} from "./plan-store.js";
import { isInteractiveTerminal } from "./prompt.js";
import { checkAgemonStateDirectoryBeforeRun } from "./state-root.js";
import { MAX_RAW_OUTPUT_LINE_CHARACTERS } from "./subprocess-runner.js";
import { skipUnapprovableGitConfigOperations } from "./untrusted-git-config.js";
import { printable } from "./untrusted-text.js";
import {
  describeFootprintRemoval,
  isWorkspaceEntry,
  removeRecordedEmptyDirectories,
  removeWorkspaceFootprint,
} from "./workspace-footprint.js";

type ConflictDecisionMap = Record<string, "keep" | "replace" | "skip">;

export type RunOutcome =
  | "applied"
  | "nothing-to-do"
  | "drift"
  | "partial"
  | "declined"
  | "previewed";

const DRIFT_EXIT_CODE = 2;

export function exitCodeForOutcome(outcome: RunOutcome): number {
  return outcome === "drift" || outcome === "partial" ? DRIFT_EXIT_CODE : 0;
}

export interface UninstallOptions {
  only?: string[];
  skipIds?: string[];
}

export type UninstallOutcome = Extract<
  RunOutcome,
  "applied" | "nothing-to-do" | "declined" | "previewed"
>;

const MAX_PREVIEW_LINES_PER_PLUGIN = 20;
const MAX_PREVIEW_LINE_CHARACTERS = 300;
const MAX_FAILURE_DETAIL_CHARACTERS = 200;
const NOTHING_TO_DO_MESSAGE =
  "Nothing to do — every managed resource already matches the desired state.";
const NOTHING_APPLIED_MESSAGE =
  "Nothing was applied; see the skipped items above.";

function singleLine(untrusted: string, maxCharacters: number): string {
  const line = printable(untrusted).replace(/[\n\t]/g, " ");
  return line.length > maxCharacters
    ? `${line.slice(0, maxCharacters)}…`
    : line;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [firstLine = ""] = message.trim().split(/\r?\n/);
  return singleLine(
    redactSecretsInText(firstLine.slice(0, MAX_RAW_OUTPUT_LINE_CHARACTERS)),
    MAX_FAILURE_DETAIL_CHARACTERS,
  );
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export interface ReconcileOptions {
  only?: string[];
  agemonVersion: string;
  allowUnignoredState: boolean;
  trustRepoGitConfig?: boolean;
  plan?: Plan;
  conflictDecisions?: ConflictDecisionMap;
  persistConfig?: boolean;
  platformSkippedCapabilities?: string[];
}

export interface BuildPlanOptions {
  only?: string[];
  agemonVersion: string;
}

function resolvePluginOrder(
  allPlugins: AgemonPlugin[],
  onlyIds: string[] | undefined,
): AgemonPlugin[] {
  const pluginById = new Map(allPlugins.map((plugin) => [plugin.id, plugin]));
  const unresolvedOnlyIds = (onlyIds ?? []).filter((id) => !pluginById.has(id));
  if (unresolvedOnlyIds.length > 0) {
    throw new Error(`Unknown plugin id(s): ${unresolvedOnlyIds.join(", ")}`);
  }

  const selected =
    onlyIds === undefined
      ? [...allPlugins]
      : allPlugins.filter((plugin) => onlyIds.includes(plugin.id));

  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: AgemonPlugin[] = [];

  const visit = (plugin: AgemonPlugin): void => {
    if (permanent.has(plugin.id)) {
      return;
    }
    if (temporary.has(plugin.id)) {
      throw new Error(`Circular dependency detected at plugin '${plugin.id}'.`);
    }

    temporary.add(plugin.id);
    for (const dependencyId of plugin.dependsOn ?? []) {
      const dependencyPlugin = pluginById.get(dependencyId);
      if (!dependencyPlugin) {
        throw new Error(
          `Plugin '${plugin.id}' depends on missing plugin '${dependencyId}'.`,
        );
      }
      visit(dependencyPlugin);
    }
    temporary.delete(plugin.id);
    permanent.add(plugin.id);
    ordered.push(plugin);
  };

  for (const plugin of selected) {
    visit(plugin);
  }

  return ordered;
}

export async function buildPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: BuildPlanOptions,
): Promise<Plan> {
  const plugins = resolvePluginOrder(allPlugins, options.only);

  const operations: ProposedOperation[] = [];
  for (const plugin of plugins) {
    const pluginOperations = (await plugin.plan?.(ctx, operations)) ?? [];
    operations.push(...pluginOperations);
  }

  const inputs = {
    capabilityIds: plugins.map((plugin) => plugin.id),
    skillGroups: ctx.skillGroupsOption ?? null,
  };
  const desiredStateHash = resolveDesiredStateHash(inputs);

  return {
    id: computePlanId({
      agemonVersion: options.agemonVersion,
      desiredStateHash,
      operations,
    }),
    agemonVersion: options.agemonVersion,
    desiredStateHash,
    inputs,
    createdAt: new Date().toISOString(),
    operations,
  };
}

function reportSkippedOperations(
  ctx: Context,
  skipped: { operation: ProposedOperation; reason: string }[],
): void {
  for (const entry of skipped) {
    ctx.ui.info(
      `Skipped ${entry.operation.action} ${
        entry.operation.targetPath || entry.operation.resourceId
      } — ${entry.reason}`,
    );
  }
}

function reportSweepProblems(ctx: Context, problems: string[]): void {
  for (const problem of problems) {
    ctx.ui.info(`  - ${problem}`);
  }
}

async function runPostApplySweep(
  ctx: Context,
  plugins: AgemonPlugin[],
  appliedCapabilityIds: ReadonlySet<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const plugin of plugins) {
    if (!appliedCapabilityIds.has(plugin.id)) {
      continue;
    }
    const verification = await plugin.verify(ctx);
    if (!verification.ok) {
      problems.push(
        `${plugin.id}: ${verification.detail ?? "verification failed"}`,
      );
    }
  }
  problems.push(...(await verifyManagedState(ctx, plugins)));
  return problems;
}

function desiredCapabilityIds(
  plugins: AgemonPlugin[],
  options: ReconcileOptions,
): string[] {
  const selectedIds = plugins.map((plugin) => plugin.id);
  const skippedOnlyByThisMachine =
    options.only === undefined
      ? (options.platformSkippedCapabilities ?? [])
      : [];
  return CORE_CAPABILITY_IDS.filter(
    (id) => selectedIds.includes(id) || skippedOnlyByThisMachine.includes(id),
  );
}

async function persistDesiredStateConfig(
  ctx: Context,
  plugins: AgemonPlugin[],
  options: ReconcileOptions,
  conflictResolutions: ConflictResolution[],
): Promise<void> {
  const conflictDecisions: ConflictDecisionMap = {};
  for (const resolution of conflictResolutions) {
    conflictDecisions[resolution.resourceId] = resolution.decision;
  }

  const configPath = await writeConfig(ctx.cwd, {
    capabilities: desiredCapabilityIds(plugins, options),
    skillGroups: ctx.skillGroupsOption ?? null,
    conflictDecisions,
    knownCapabilities: CORE_CAPABILITY_IDS,
  });

  ctx.ui.info(
    `Wrote ${relative(ctx.cwd, configPath)} — commit it so teammates and CI reconcile the same way.`,
  );
}

async function removeDesiredStateConfig(ctx: Context): Promise<void> {
  await rm(resolveConfigPath(ctx.cwd), { force: true });
}

async function previewAndStop(ctx: Context, plan: Plan): Promise<void> {
  const planPath = await writePlan(ctx.cwd, plan);
  ctx.log.log(renderPlan(plan));
  ctx.log.log(`\nPlan written to ${relative(ctx.cwd, planPath)}`);
  if (plan.operations.length > 0) {
    ctx.log.log(
      `Review, then re-run interactively or with --yes, or 'agemon apply --plan ${plan.id}'.`,
    );
  }
}

function assertPlanIsCompatible(
  plan: Plan,
  allPlugins: AgemonPlugin[],
  agemonVersion: string,
): void {
  if (plan.agemonVersion !== agemonVersion) {
    throw new Error(
      `Plan ${plan.id} was made by agemon ${printable(plan.agemonVersion)}; this is agemon ${agemonVersion}. Re-run 'agemon plan'.`,
    );
  }

  const pluginById = new Map(allPlugins.map((plugin) => [plugin.id, plugin]));
  const unknownCapabilityIds = [
    ...new Set(
      plan.operations
        .map((operation) => operation.capabilityId)
        .filter((capabilityId) => !pluginById.has(capabilityId)),
    ),
  ];
  if (unknownCapabilityIds.length > 0) {
    throw new Error(
      `Plan ${plan.id} references unknown capabilities: ${unknownCapabilityIds.map(printable).join(", ")}.`,
    );
  }

  const foreignSharedOperation = plan.operations.find(
    (operation) =>
      operation.action === "use-shared" &&
      !pluginById
        .get(operation.capabilityId)
        ?.sharedResources?.some(
          (resource) =>
            resource.id === operation.targetPath &&
            resource.id === operation.resourceId,
        ),
  );
  if (foreignSharedOperation) {
    throw new Error(
      `Plan ${plan.id} asks ${foreignSharedOperation.capabilityId} to use the shared tool ${printable(foreignSharedOperation.targetPath)}, which it does not manage.`,
    );
  }

  const fileActionForNonWriter = plan.operations.find(
    (operation) =>
      FILE_TARGETING_ACTIONS.has(operation.action) &&
      !pluginById.get(operation.capabilityId)?.materialize,
  );
  if (fileActionForNonWriter) {
    throw new Error(
      `Plan ${plan.id} asks ${fileActionForNonWriter.capabilityId} to ${fileActionForNonWriter.action} ${printable(fileActionForNonWriter.targetPath)}, which it never does.`,
    );
  }
}

const REPLAN_ADVICE =
  "Run 'agemon plan' again with the options you want, review it, then apply that plan.";

function describeSkillGroupsInput(skillGroups: string | null): string {
  return skillGroups === null ? "the default" : `"${printable(skillGroups)}"`;
}

function describePlanMismatch(stored: Plan, rebuilt: Plan): string {
  const storedCapabilities = stored.inputs.capabilityIds.map(printable);
  const rebuiltCapabilities = rebuilt.inputs.capabilityIds;
  if (storedCapabilities.join(",") !== rebuiltCapabilities.join(",")) {
    return `Plan ${stored.id} was made for capabilities [${storedCapabilities.join(", ")}]; this run selects [${rebuiltCapabilities.join(", ")}] (from --only, --skip-daemon or agemon.toml).`;
  }
  if (stored.inputs.skillGroups !== rebuilt.inputs.skillGroups) {
    return `Plan ${stored.id} was made with ${describeSkillGroupsInput(stored.inputs.skillGroups)} skill groups; this run has ${describeSkillGroupsInput(rebuilt.inputs.skillGroups)}.`;
  }
  const rebuiltById = new Map(
    rebuilt.operations.map((operation) => [operation.id, operation]),
  );
  const gitConfigChanged = stored.operations.some((operation) => {
    const counterpart = rebuiltById.get(operation.id);
    return (
      counterpart !== undefined &&
      JSON.stringify(counterpart.untrustedGitConfig ?? null) !==
        JSON.stringify(operation.untrustedGitConfig ?? null)
    );
  });
  if (gitConfigChanged) {
    return `Plan ${stored.id} no longer matches what agemon would do now: this repository's git config changed since the plan.`;
  }
  return `Plan ${stored.id} no longer matches what agemon would do now: the repository changed since it was made, or the plan file was edited.`;
}

async function rebuildStoredPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: ReconcileOptions,
  stored: Plan,
): Promise<Plan> {
  const rebuilt = await buildPlan(
    { ...ctx, dryRun: true, yes: false, interactive: false },
    allPlugins,
    { only: options.only, agemonVersion: options.agemonVersion },
  );
  if (planContentFingerprint(rebuilt) !== planContentFingerprint(stored)) {
    throw new Error(
      `${describePlanMismatch(stored, rebuilt)} ${REPLAN_ADVICE}`,
    );
  }
  return rebuilt;
}

function isSettledConflict(skip: SkippedOperation): boolean {
  return skip.operation.action === "conflict" && !skip.consentMissing;
}

async function reportInstalledCapabilityAttention(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<void> {
  const recordedPluginIds = new Set(
    ctx.manifest.getActions().map((action) => action.plugin),
  );
  for (const plugin of plugins) {
    if (!recordedPluginIds.has(plugin.id)) {
      continue;
    }
    const { attention } = await plugin.verify(ctx);
    if (attention) {
      ctx.ui.info(`${plugin.id}: ${printable(attention)}`);
    }
  }
}

async function finishWithNothingToApply(
  ctx: Context,
  plugins: AgemonPlugin[],
  options: ReconcileOptions,
  conflictResolutions: ConflictResolution[],
  successMessage = NOTHING_TO_DO_MESSAGE,
): Promise<RunOutcome> {
  await reportInstalledCapabilityAttention(ctx, plugins);
  const driftProblems = await verifyManagedState(ctx, plugins);
  if (driftProblems.length > 0) {
    ctx.ui.fail("Nothing to apply, but the environment has drifted:");
    reportSweepProblems(ctx, driftProblems);
    return "drift";
  }
  if (options.persistConfig) {
    await persistDesiredStateConfig(ctx, plugins, options, conflictResolutions);
  }
  ctx.ui.succeed(successMessage);
  return "nothing-to-do";
}

export async function reconcile(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: ReconcileOptions,
): Promise<RunOutcome> {
  await checkAgemonStateDirectoryBeforeRun(ctx.dryRun, (line) =>
    ctx.ui.info(line),
  );
  await assertNoInterruptedApply(ctx.cwd);
  const plugins = resolvePluginOrder(allPlugins, options.only);

  if (plugins.length === 0) {
    ctx.ui.info("Nothing to do — no capabilities selected.");
    return "nothing-to-do";
  }

  if (options.plan) {
    assertPlanIsCompatible(options.plan, allPlugins, options.agemonVersion);
  }

  const plan = options.plan
    ? await rebuildStoredPlan(ctx, allPlugins, options, options.plan)
    : await buildPlan(ctx, allPlugins, {
        only: options.only,
        agemonVersion: options.agemonVersion,
      });

  if (ctx.dryRun) {
    await previewAndStop(ctx, plan);
    return "previewed";
  }

  const { isolation } = await discoverRepository(ctx);
  const sessionCannotConsent = !ctx.yes && !isInteractiveTerminal();
  const isFirstRun = options.persistConfig === true;
  const needsConsentBeforeApplying =
    plan.operations.some((operation) => operation.action !== "use-shared") ||
    (plan.operations.length > 0 && isolation.status !== "ignored");
  if (sessionCannotConsent && isFirstRun && needsConsentBeforeApplying) {
    await previewAndStop(ctx, plan);
    return "previewed";
  }
  if (isolation.trackingCheckError !== null) {
    ctx.ui.info(isolation.trackingCheckError);
  }

  if (plan.operations.length === 0) {
    return finishWithNothingToApply(ctx, plugins, options, []);
  }

  const { approvable, skipped: untrustedGitConfigSkips } =
    skipUnapprovableGitConfigOperations(plan.operations);
  const consentablePlan = { ...plan, operations: approvable };
  const gates = buildConsentGates({
    plan: consentablePlan,
    isolationStatus: isolation.status,
    trustRepoGitConfig: options.trustRepoGitConfig === true,
  });
  const approval = await ctx.consent(gates, {
    conflictDecisions: options.conflictDecisions,
  });
  const stateCanBeWritten =
    isolation.status === "ignored" ||
    approval.workspaceIsolationApproved === true ||
    options.allowUnignoredState;
  const sharedOperations = useSharedOperations(consentablePlan);
  const skipped: SkippedOperation[] = [
    ...untrustedGitConfigSkips,
    ...approval.skipped,
    ...(stateCanBeWritten
      ? []
      : sharedOperations.map((operation) => ({
          operation,
          reason: "needs /.agemon/ git-ignored",
          consentMissing: sessionCannotConsent,
        }))),
  ];
  const toApply = [
    ...approval.approved,
    ...(stateCanBeWritten ? sharedOperations : []),
  ];
  const consentMissing = skipped.some((skip) => skip.consentMissing);

  if (toApply.length === 0) {
    if (skipped.every(isSettledConflict)) {
      return finishWithNothingToApply(
        ctx,
        plugins,
        options,
        approval.conflictResolutions,
      );
    }
    await reportInstalledCapabilityAttention(ctx, plugins);
    ctx.log.log(
      renderRunSummary({
        kind: "declined",
        skipped: skipped.map((skip) => ({
          label: skip.operation.targetPath || skip.operation.resourceId,
          reason: skip.reason,
        })),
      }),
    );
    return consentMissing ? "drift" : "declined";
  }

  let result: Awaited<ReturnType<typeof applyPlan>>;
  try {
    result = await applyPlan(ctx, allPlugins, {
      plan,
      approved: toApply,
      workspaceIsolationApproved: approval.workspaceIsolationApproved,
      isolationStatus: isolation.status,
      allowUnignoredState: options.allowUnignoredState,
    });
  } catch (error) {
    if (error instanceof ApplyRollbackError) {
      ctx.log.log(renderRunSummary({ kind: "failure", ...error.rollback }));
    }
    throw error;
  }

  reportSkippedOperations(ctx, [...skipped, ...result.skipped]);
  if (result.applied.length === 0) {
    const outcome = await finishWithNothingToApply(
      ctx,
      plugins,
      options,
      approval.conflictResolutions,
      NOTHING_APPLIED_MESSAGE,
    );
    return consentMissing && outcome === "nothing-to-do" ? "drift" : outcome;
  }

  const appliedCapabilityIds = new Set(
    result.applied.map((operation) => operation.capabilityId),
  );
  const sweepProblems = await runPostApplySweep(
    ctx,
    plugins,
    appliedCapabilityIds,
  );
  if (sweepProblems.length > 0) {
    ctx.log.log(
      renderRunSummary({
        kind: "partial",
        appliedCount: result.applied.length,
        problems: sweepProblems,
      }),
    );
    return "partial";
  }

  if (options.persistConfig) {
    await persistDesiredStateConfig(
      ctx,
      plugins,
      options,
      approval.conflictResolutions,
    );
  }

  ctx.log.log(
    renderRunSummary({
      kind: "success",
      applied: result.applied,
      nextSteps: buildNextSteps(options, isolation.trackedAgemonPaths),
    }),
  );
  return consentMissing ? "drift" : "applied";
}

function buildNextSteps(
  options: ReconcileOptions,
  trackedAgemonPaths: string[],
): string[] {
  const steps: string[] = [];
  if (options.persistConfig) {
    steps.push("commit agemon.toml so teammates and CI reconcile the same way");
  }
  if (trackedAgemonPaths.length > 0) {
    steps.push("git rm -r --cached .agemon to stop tracking regenerated state");
  }
  return steps;
}

function selectUninstallRequest(
  allPlugins: AgemonPlugin[],
  options: UninstallOptions,
): Set<string> {
  const knownIds = new Set(allPlugins.map((plugin) => plugin.id));
  const unknownIds = (options.only ?? []).filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown plugin id(s): ${unknownIds.join(", ")}`);
  }
  const requested = options.only ?? [...knownIds];
  return new Set(
    requested.filter((id) => !(options.skipIds ?? []).includes(id)),
  );
}

function reasonToKeep(
  plugin: AgemonPlugin,
  allPlugins: AgemonPlugin[],
  installedIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
): string | null {
  const dependent = allPlugins.find(
    (candidate) =>
      installedIds.has(candidate.id) &&
      (candidate.dependsOn ?? []).includes(plugin.id),
  );
  if (dependent === undefined) {
    return null;
  }
  return failedIds.has(dependent.id)
    ? `${dependent.id} could not be uninstalled`
    : `${dependent.id} is still installed`;
}

function pluginsWithLedgerEntries(ctx: Context): Set<string> {
  return new Set(
    ctx.manifest
      .getActions()
      .filter((action) => !isWorkspaceEntry(action))
      .map((action) => action.plugin),
  );
}

function removesLastCapability(
  remainingIds: ReadonlySet<string>,
  installedBefore: ReadonlySet<string>,
  hasSelectionFilter: boolean,
): boolean {
  return (
    remainingIds.size === 0 &&
    (!hasSelectionFilter || remainingIds.size < installedBefore.size)
  );
}

class PreviewPromptError extends Error {}

function previewContext(
  ctx: Context,
  collect: (line: string) => void,
): Context {
  const refuse = (): never => {
    throw new PreviewPromptError("the nuke preview must not ask for consent");
  };
  const refuseCommand = (): never => {
    throw new PreviewPromptError("the nuke preview must not run commands");
  };
  return {
    ...ctx,
    dryRun: true,
    ui: { start() {}, succeed() {}, fail() {}, info: collect },
    confirm: refuse,
    consent: refuse,
    run: refuseCommand,
    serviceManager: {
      kind: ctx.serviceManager.kind,
      isActive: refuseCommand,
      registerAutostart: refuseCommand,
      unregisterAutostart: refuseCommand,
      readUnitWorkingDirectory: (unitName) =>
        ctx.serviceManager.readUnitWorkingDirectory(unitName),
      readUnitEnvironment: (unitName) =>
        ctx.serviceManager.readUnitEnvironment(unitName),
      unitPathFor: (unitName) => ctx.serviceManager.unitPathFor(unitName),
      isLingerEnabled: refuseCommand,
      enableLinger: refuseCommand,
      disableLinger: refuseCommand,
      findAgemonDaemonUnit: () => ctx.serviceManager.findAgemonDaemonUnit(),
    },
  };
}

async function previewPluginReversal(
  ctx: Context,
  plugin: AgemonPlugin,
): Promise<string[]> {
  const planned: string[] = [];
  try {
    await plugin.uninstall(
      previewContext(ctx, (line) =>
        planned.push(singleLine(line, MAX_PREVIEW_LINE_CHARACTERS)),
      ),
    );
  } catch (error) {
    if (error instanceof PreviewPromptError) {
      throw error;
    }
    planned.push(`could not preview (${describeFailure(error)})`);
  }
  const overflow = planned.length - MAX_PREVIEW_LINES_PER_PLUGIN;
  return [
    ...planned.slice(0, MAX_PREVIEW_LINES_PER_PLUGIN),
    ...(overflow > 0
      ? [`… ${overflow} more — run 'agemon nuke --dry-run' for the full list`]
      : []),
  ];
}

async function describeReversal(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  orderedRequest: AgemonPlugin[],
  hasSelectionFilter: boolean,
): Promise<string[]> {
  const lines: string[] = [];
  const installedBefore = pluginsWithLedgerEntries(ctx);
  const remainingIds = new Set(installedBefore);
  for (const plugin of orderedRequest) {
    if (!installedBefore.has(plugin.id)) {
      continue;
    }
    const keptBecause = reasonToKeep(
      plugin,
      allPlugins,
      remainingIds,
      new Set(),
    );
    if (keptBecause !== null) {
      lines.push(`kept: ${plugin.id} (${keptBecause})`);
      continue;
    }
    const planned = await previewPluginReversal(ctx, plugin);
    lines.push(`${plugin.id}:`, ...planned.map((line) => `  ${line}`));
    remainingIds.delete(plugin.id);
  }
  const lastCapabilityGoes = removesLastCapability(
    remainingIds,
    installedBefore,
    hasSelectionFilter,
  );
  if (lastCapabilityGoes && (await fileExists(resolveConfigPath(ctx.cwd)))) {
    lines.push("agemon.toml (deleted)");
  }
  lines.push(...describeFootprintRemoval(ctx, lastCapabilityGoes));
  return lines;
}

async function confirmReversal(
  ctx: Context,
  reversal: string[],
): Promise<UninstallOutcome | null> {
  ctx.log.log(
    ["agemon nuke will reverse:", ...reversal.map((line) => `  ${line}`)].join(
      "\n",
    ),
  );
  if (!ctx.interactive) {
    ctx.log.log("Re-run with --yes to reverse these changes.");
    return "previewed";
  }
  return (await ctx.confirm("Reverse these changes?")) ? null : "declined";
}

export async function uninstallPlugins(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  options: UninstallOptions,
): Promise<UninstallOutcome> {
  await checkAgemonStateDirectoryBeforeRun(ctx.dryRun, (line) =>
    ctx.ui.info(line),
  );
  await assertNoInterruptedApply(ctx.cwd);
  const requestedIds = selectUninstallRequest(allPlugins, options);
  const orderedRequest = resolvePluginOrder(allPlugins, undefined)
    .reverse()
    .filter((plugin) => requestedIds.has(plugin.id));

  if (orderedRequest.length === 0) {
    ctx.ui.info("Nothing to do — no plugins selected.");
    return "nothing-to-do";
  }

  const hasSelectionFilter =
    options.only !== undefined || (options.skipIds ?? []).length > 0;
  const installedBefore = pluginsWithLedgerEntries(ctx);
  const installedIds = new Set(installedBefore);
  if (!ctx.dryRun && !ctx.yes) {
    const reversal = await describeReversal(
      ctx,
      allPlugins,
      orderedRequest,
      hasSelectionFilter,
    );
    const stopOutcome =
      reversal.length > 0 ? await confirmReversal(ctx, reversal) : null;
    if (stopOutcome !== null) {
      return stopOutcome;
    }
  }

  const entriesBefore = ctx.manifest.getActions().length;
  const failedIds = new Set<string>();
  const failures: string[] = [];
  const total = orderedRequest.length;
  let step = 0;
  for (const plugin of orderedRequest) {
    step += 1;
    const keptBecause = reasonToKeep(
      plugin,
      allPlugins,
      installedIds,
      failedIds,
    );
    if (keptBecause !== null) {
      ctx.ui.info(`kept: ${plugin.id} (${keptBecause})`);
      continue;
    }
    ctx.ui.start(`Uninstalling ${plugin.id}`, { step, total });
    try {
      await plugin.uninstall(ctx);
      if (!ctx.dryRun) {
        await ctx.manifest.removeActionsForPlugin(plugin.id);
      }
      installedIds.delete(plugin.id);
      ctx.ui.succeed(`Uninstalled ${plugin.id}`);
    } catch (error) {
      failedIds.add(plugin.id);
      failures.push(`${plugin.id} (${describeFailure(error)})`);
      ctx.ui.fail(`Could not uninstall ${plugin.id}`);
    }
  }

  if (ctx.dryRun) {
    const lastCapabilityGoes =
      failures.length === 0 &&
      removesLastCapability(installedIds, installedBefore, hasSelectionFilter);
    for (const line of describeFootprintRemoval(ctx, lastCapabilityGoes)) {
      ctx.ui.info(`Would ${line}`);
    }
    return "previewed";
  }

  const removedEntries = ctx.manifest.getActions().length < entriesBefore;
  await removeRecordedEmptyDirectories(ctx);
  if (
    failures.length === 0 &&
    !ctx.manifest.hasCapabilityActions() &&
    (!hasSelectionFilter || removedEntries)
  ) {
    await removeDesiredStateConfig(ctx);
    await removeWorkspaceFootprint(ctx);
  }
  await ctx.manifest.pruneIfEmpty();

  if (failures.length > 0) {
    throw new Error(
      `nuke could not reverse ${failures.join("; ")}. Their ledger entries are kept — fix the cause and re-run 'agemon nuke'.`,
    );
  }
  return "applied";
}
