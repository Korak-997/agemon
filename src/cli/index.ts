import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { Command, CommanderError } from "commander";
import {
  addCapabilitiesToConfig,
  capabilitiesToAutoAdd,
  outcomeUpdatesConfig,
} from "../core/capability-migration.js";
import {
  type AgemonConfig,
  type CustomSkillGroupConfig,
  loadConfig,
} from "../core/config.js";
import { createContext } from "../core/context.js";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
import {
  assertNotRootOnMacOS,
  assertRootUsesItsOwnEnvironment,
} from "../core/install-location.js";
import {
  readPackageVersion,
  resolveInstallMethod,
} from "../core/install-method.js";
import { ApplyInterruptedError } from "../core/interruption.js";
import {
  buildPlan,
  exitCodeForOutcome,
  type RunOutcome,
  reconcile,
  uninstallPlugins,
} from "../core/orchestrator.js";
import { assertValidPlanId, readPlan, writePlan } from "../core/plan-store.js";
import { isInteractiveTerminal } from "../core/prompt.js";
import {
  RECOVER_LIMIT_NOTE,
  recoverInterruptedApply,
} from "../core/recover.js";
import { resolveRepositoryRoot } from "../core/repo-paths.js";
import { runSelfUninstall } from "../core/self-uninstall.js";
import { runRollback, runUpgrade } from "../core/self-upgrade.js";
import {
  checkAgemonStateDirectoryBeforeRun,
  withRepositoryRunLock,
} from "../core/state-root.js";
import { printable } from "../core/untrusted-text.js";
import { startUpdateCheck } from "../core/update-check.js";
import { runInspect } from "../inspect/index.js";
import { runStatus } from "../inspect/status.js";
import {
  assertPlatformSupportsChanges,
  detectPlatformCapabilities,
  type PlatformCapabilities,
} from "../platform/detect.js";
import {
  hasPinnedBuildFor,
  pinnedArchiveKeyFor,
} from "../plugins/cli-tool/index.js";
import { CORE_CAPABILITY_IDS, getRegisteredPlugins } from "../plugins/index.js";
import { assertCustomSkillGroupsAreValid } from "../plugins/skills/catalog.js";
import type { AgemonPlugin } from "../plugins/types.js";
import { renderBanner } from "../ui/banner.js";
import { box } from "../ui/box.js";
import { renderPlan } from "../ui/plan-view.js";
import {
  createStepProgress,
  SILENT_PROGRESS,
  type StepProgress,
} from "../ui/progress.js";
import { createStepSpinner, type StepSpinner } from "../ui/spinner.js";
import { symbol } from "../ui/symbols.js";
import { theme } from "../ui/theme.js";

const VERSION = readPackageVersion();
const DESCRIPTION =
  "Bootstraps and reverses an AI coding agent's working environment in a repo.";

interface CliOptions {
  dryRun?: boolean;
  yes?: boolean;
  only?: string;
  skipDaemon?: boolean;
  skillGroups?: string;
  json?: boolean;
  allowUnignoredState?: boolean;
  plan?: string;
  quiet?: boolean;
  verbose?: boolean;
  checkAgentsUsable?: boolean;
  removeShared?: string;
  print?: boolean;
  rollback?: boolean;
  platformSkippedIds?: string[];
}

const SILENT_SPINNER: StepSpinner = {
  start() {},
  succeed() {},
  fail() {},
  info() {},
};

function selectSpinner(options: CliOptions): StepSpinner {
  if (options.quiet) {
    return SILENT_SPINNER;
  }
  return createStepSpinner({ animated: !options.verbose });
}

function selectProgress(options: CliOptions): StepProgress {
  return options.quiet ? SILENT_PROGRESS : createStepProgress();
}

function openInteractiveFrame(options: CliOptions): void {
  if (!options.quiet && isInteractiveTerminal()) {
    intro(theme.heading(`agemon ${VERSION}`));
  }
}

function closeInteractiveFrame(
  options: CliOptions,
  tone: "success" | "failure" = "success",
): void {
  if (!options.quiet && isInteractiveTerminal()) {
    outro(tone === "success" ? theme.ok("done") : theme.danger("failed"));
  }
}

const ERROR_HINTS: { match: RegExp; hint: string }[] = [
  {
    match: /is stale/,
    hint: "run 'agemon plan' to refresh, then 'agemon apply'.",
  },
  {
    match: /not git-ignored|isolation/i,
    hint: "add /.agemon/ to .gitignore, or re-run interactively or with --yes.",
  },
  {
    match: /\.gitignore: it is not a regular file/,
    hint: "replace the .gitignore symlink with a regular file, or pass --allow-unignored-state.",
  },
];

export function renderCliError(untrustedMessage: string): string {
  const message = printable(untrustedMessage);
  const hint = ERROR_HINTS.find((entry) => entry.match.test(message))?.hint;
  const lines = [
    `${symbol("fail")} ${message}`,
    ...(hint ? [`${symbol("arrow")} ${hint}`] : []),
  ];
  return box({ body: lines.join("\n"), tone: "danger" });
}

function excludedPluginIds(options: CliOptions): string[] {
  return [
    ...(options.skipDaemon ? ["daemon"] : []),
    ...(options.platformSkippedIds ?? []),
  ];
}

function selectPlugins(options: CliOptions): AgemonPlugin[] {
  const excludedIds = excludedPluginIds(options);
  return getRegisteredPlugins().filter(
    (plugin) => !excludedIds.includes(plugin.id),
  );
}

function describeMissingServiceManager(platform: PlatformCapabilities): string {
  return platform.family === "linux"
    ? "systemd is not running on this machine"
    : "agemon has no service manager for this OS yet";
}

function findWhatThisMachineCannotRun(
  options: CliOptions,
  platform: PlatformCapabilities,
): { id: string; reason: string }[] {
  const unrunnable: { id: string; reason: string }[] = [];
  if (!options.skipDaemon && platform.serviceManager === "none") {
    unrunnable.push({
      id: "daemon",
      reason: describeMissingServiceManager(platform),
    });
  }
  if (!hasPinnedBuildFor(platform)) {
    unrunnable.push({
      id: "cli-tool",
      reason: `agnix has no pinned build for ${pinnedArchiveKeyFor(platform)}`,
    });
  }
  return unrunnable;
}

function skippingWhatThisMachineCannotRun(
  options: CliOptions,
  platform: PlatformCapabilities,
): CliOptions {
  const unrunnable = findWhatThisMachineCannotRun(options, platform);
  if (unrunnable.length === 0) {
    return options;
  }
  const onlyIds = parseOnlyOption(options);
  for (const { id, reason } of unrunnable) {
    if (onlyIds?.includes(id)) {
      throw new Error(`--only ${id} cannot run here: ${reason}.`);
    }
    if (onlyIds === undefined && !options.quiet && !options.json) {
      console.error(theme.dim(`${id} skipped: ${reason}.`));
    }
  }
  return { ...options, platformSkippedIds: unrunnable.map(({ id }) => id) };
}

function parseOnlyOption(options: CliOptions): string[] | undefined {
  if (options.only === undefined) {
    return undefined;
  }
  const ids = options.only
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new Error("--only needs at least one plugin id");
  }
  if (options.skipDaemon && ids.includes("daemon")) {
    throw new Error("--only daemon conflicts with --skip-daemon");
  }
  return ids;
}

async function resolveRepositoryRootFor(options: CliOptions): Promise<string> {
  const { root, notice } = await resolveRepositoryRoot(process.cwd());
  if (notice !== null && !options.quiet && !options.json) {
    console.error(theme.dim(notice));
  }
  return root;
}

function assertConfiguredCapabilitiesAreKnown(config: AgemonConfig): void {
  const knownIds = getRegisteredPlugins().map((plugin) => plugin.id);
  const unknownIds = config.capabilities.filter((id) => !knownIds.includes(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `agemon.toml lists unknown capabilities: ${unknownIds.map(printable).join(", ")}. Known: ${knownIds.join(", ")}.`,
    );
  }
}

const ADDED_CAPABILITY_PURPOSE =
  "installs Claude Code subagents for your skill groups";

interface DesiredStateDefaults {
  config: AgemonConfig | null;
  only: string[] | undefined;
  skillGroups: string | undefined;
  customSkillGroups: CustomSkillGroupConfig[];
  addedCapabilityIds: string[];
}

function quoteCapabilityIds(capabilityIds: string[]): string {
  return capabilityIds.map((id) => `'${id}'`).join(", ");
}

function announceAddedCapabilities(
  options: CliOptions,
  addedCapabilityIds: string[],
  willUpdateConfig: boolean,
): void {
  if (addedCapabilityIds.length === 0 || options.quiet) {
    return;
  }
  const when = willUpdateConfig
    ? "agemon.toml is updated when this run completes"
    : "agemon.toml is updated on the next interactive or --yes run";
  console.error(
    theme.dim(
      `agemon.toml does not list the new capability ${quoteCapabilityIds(addedCapabilityIds)} (${ADDED_CAPABILITY_PURPOSE}) yet; this run includes it (${when}).`,
    ),
  );
}

async function updateConfigWithAddedCapabilities(
  repoRoot: string,
  config: AgemonConfig,
  addedCapabilityIds: string[],
  allowUnignoredState: boolean,
): Promise<string> {
  const added = quoteCapabilityIds(addedCapabilityIds);
  const update = await addCapabilitiesToConfig(
    repoRoot,
    config,
    addedCapabilityIds,
    { knownCapabilities: CORE_CAPABILITY_IDS, allowUnignoredState },
  );
  if (update.kind === "state-not-ignored") {
    return `Left agemon.toml unchanged: /.agemon/ is not git-ignored, so agemon keeps no backup of it there. Add /.agemon/ to .gitignore (or pass --allow-unignored-state) and run agemon again to add ${added}.`;
  }
  if (update.kind === "not-written") {
    return `Left agemon.toml unchanged: ${update.reason}. The next run tries again, or add ${added} to capabilities by hand.`;
  }
  const savedOriginal =
    update.backupPath === null
      ? ""
      : ` Comments and layout were not kept; the original is saved at ${update.backupPath} (a full 'agemon nuke' deletes .agemon/, so keep a copy if you need it).`;
  return `Updated agemon.toml: added ${added} (${ADDED_CAPABILITY_PURPOSE}) to capabilities; remove it there to opt out.${savedOriginal} Commit agemon.toml; older agemon versions reject it, so upgrade agemon in CI first.`;
}

async function recordAddedCapabilities(
  repoRoot: string,
  defaults: DesiredStateDefaults,
  run: {
    outcome: RunOutcome;
    approvable: boolean;
    allowUnignoredState: boolean;
  },
): Promise<void> {
  const { config, addedCapabilityIds } = defaults;
  if (config === null || addedCapabilityIds.length === 0 || !run.approvable) {
    return;
  }
  if (!outcomeUpdatesConfig(run.outcome)) {
    console.log(
      "Left agemon.toml unchanged: this run applied nothing that was approved. The next run tries again.",
    );
    return;
  }
  console.log(
    await updateConfigWithAddedCapabilities(
      repoRoot,
      config,
      addedCapabilityIds,
      run.allowUnignoredState,
    ),
  );
}

async function resolveDesiredStateDefaults(
  options: CliOptions,
  repoRoot: string,
): Promise<DesiredStateDefaults> {
  const config = await loadConfig(repoRoot);
  if (config) {
    assertConfiguredCapabilitiesAreKnown(config);
    assertCustomSkillGroupsAreValid(config.customSkillGroups);
  }

  const addedCapabilityIds =
    config === null
      ? []
      : capabilitiesToAutoAdd(config, getRegisteredPlugins());
  const excludedIds = excludedPluginIds(options);
  const configuredIds = config?.capabilities
    .concat(addedCapabilityIds)
    .filter((id) => !excludedIds.includes(id));
  const only = parseOnlyOption(options);

  return {
    config,
    only: only ?? configuredIds,
    skillGroups: options.skillGroups ?? config?.skillGroups ?? undefined,
    customSkillGroups: config?.customSkillGroups ?? [],
    addedCapabilityIds: only === undefined ? addedCapabilityIds : [],
  };
}

interface ReportConfig {
  customSkillGroups: CustomSkillGroupConfig[];
  configError: string | null;
}

async function loadConfigForReport(repoRoot: string): Promise<ReportConfig> {
  try {
    const config = await loadConfig(repoRoot);
    const customSkillGroups = config?.customSkillGroups ?? [];
    assertCustomSkillGroupsAreValid(customSkillGroups);
    return { customSkillGroups, configError: null };
  } catch (error) {
    return {
      customSkillGroups: [],
      configError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runInspectCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const { customSkillGroups, configError } =
    await loadConfigForReport(repoRoot);
  const context = await createContext({
    repoRoot,
    platform: await detectPlatformCapabilities(),
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
    customSkillGroups,
  });

  await runInspect(context, {
    json: Boolean(options.json),
    checkAgentsUsable: Boolean(options.checkAgentsUsable),
    configError,
  });
  return 0;
}

async function runStatusCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const { customSkillGroups, configError } =
    await loadConfigForReport(repoRoot);
  const context = await createContext({
    repoRoot,
    platform: await detectPlatformCapabilities(),
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
    customSkillGroups,
  });

  const report = await runStatus(context, getRegisteredPlugins(), {
    configError,
  });
  return report.configError === null &&
    (report.healthy || !report.hasAgemonState)
    ? 0
    : exitCodeForOutcome("drift");
}

async function runPlanCommand(requested: CliOptions): Promise<number> {
  assertNotRootOnMacOS();
  const platform = await detectPlatformCapabilities();
  const options = skippingWhatThisMachineCannotRun(requested, platform);
  const repoRoot = await resolveRepositoryRootFor(options);
  const plugins = selectPlugins(options);
  const { only, skillGroups, customSkillGroups, addedCapabilityIds } =
    await resolveDesiredStateDefaults(options, repoRoot);
  announceAddedCapabilities(options, addedCapabilityIds, false);
  const context = await createContext({
    repoRoot,
    platform,
    dryRun: true,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
    skillGroups,
    customSkillGroups,
  });

  const plan = await buildPlan(context, plugins, {
    only,
    agemonVersion: VERSION,
  });
  const planPath = await writePlan(context.cwd, plan);

  context.log.log(renderPlan(plan));
  context.log.log(`\nPlan written to ${relative(context.cwd, planPath)}`);
  return 0;
}

async function runInstall(requested: CliOptions): Promise<number> {
  const platform = await detectPlatformCapabilities();
  const options = skippingWhatThisMachineCannotRun(requested, platform);
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const defaults = await resolveDesiredStateDefaults(options, repoRoot);
  const { config, only, skillGroups, customSkillGroups } = defaults;
  const dryRun = Boolean(options.dryRun);
  const approvable = Boolean(options.yes) || isInteractiveTerminal();
  announceAddedCapabilities(
    options,
    defaults.addedCapabilityIds,
    approvable && !dryRun,
  );
  openInteractiveFrame(options);
  let outcome: RunOutcome;
  try {
    const context = await createContext({
      repoRoot,
      platform,
      dryRun,
      yes: Boolean(options.yes),
      ui: spinner,
      verbose: Boolean(options.verbose),
      progress: selectProgress(options),
      skillGroups,
      customSkillGroups,
    });

    outcome = await reconcile(context, plugins, {
      only,
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      conflictDecisions: config?.conflictDecisions,
      persistConfig: config === null,
      platformSkippedCapabilities: options.platformSkippedIds ?? [],
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  if (!dryRun) {
    await recordAddedCapabilities(repoRoot, defaults, {
      outcome,
      approvable,
      allowUnignoredState: Boolean(options.allowUnignoredState),
    });
  }
  return exitCodeForOutcome(outcome);
}

async function runApply(requested: CliOptions): Promise<number> {
  if (requested.plan) {
    assertValidPlanId(requested.plan);
  }
  const platform = await detectPlatformCapabilities();
  const options = skippingWhatThisMachineCannotRun(requested, platform);
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const defaults = await resolveDesiredStateDefaults(options, repoRoot);
  const { config, only, skillGroups, customSkillGroups } = defaults;
  const approvable = Boolean(options.yes) || isInteractiveTerminal();
  announceAddedCapabilities(options, defaults.addedCapabilityIds, approvable);
  openInteractiveFrame(options);
  let outcome: RunOutcome;
  try {
    const context = await createContext({
      repoRoot,
      platform,
      dryRun: false,
      yes: Boolean(options.yes),
      ui: spinner,
      verbose: Boolean(options.verbose),
      progress: selectProgress(options),
      skillGroups,
      customSkillGroups,
    });

    const plan = options.plan
      ? await readPlan(context.cwd, options.plan)
      : undefined;

    outcome = await reconcile(context, plugins, {
      only,
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      plan,
      conflictDecisions: config?.conflictDecisions,
      persistConfig: config === null,
      platformSkippedCapabilities: options.platformSkippedIds ?? [],
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  await recordAddedCapabilities(repoRoot, defaults, {
    outcome,
    approvable,
    allowUnignoredState: Boolean(options.allowUnignoredState),
  });
  return exitCodeForOutcome(outcome);
}

function parseRemoveSharedOption(
  options: CliOptions,
  plugins: AgemonPlugin[],
): ReadonlySet<string> {
  if (options.removeShared === undefined) {
    return new Set();
  }
  const knownToolNames = plugins.flatMap((plugin) =>
    (plugin.sharedResources ?? [])
      .filter((resource) => resource.migratesFromRepoLedgers)
      .map((resource) => resource.toolName),
  );
  const toolNames = options.removeShared
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknownToolNames = toolNames.filter(
    (name) => !knownToolNames.includes(name),
  );
  if (toolNames.length === 0 || unknownToolNames.length > 0) {
    throw new Error(
      `--remove-shared takes a comma-separated list of: ${knownToolNames.join(", ")}`,
    );
  }
  return new Set(toolNames);
}

async function runNuke(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = getRegisteredPlugins();
  const removeSharedTools = parseRemoveSharedOption(options, plugins);
  const context = await createContext({
    repoRoot,
    platform: await detectPlatformCapabilities(),
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
    verbose: Boolean(options.verbose),
    progress: selectProgress(options),
    removeSharedTools,
  });

  const outcome = await uninstallPlugins(context, plugins, {
    only: parseOnlyOption(options),
    skipIds: options.skipDaemon ? ["daemon"] : [],
  });
  return exitCodeForOutcome(outcome);
}

function refusingUnsupportedPlatforms(
  run: (options: CliOptions) => Promise<void>,
): (options: CliOptions) => Promise<void> {
  return async (options) => {
    assertPlatformSupportsChanges(await detectPlatformCapabilities());
    assertNotRootOnMacOS();
    await run(options);
  };
}

function lockingTheRepository(
  run: (options: CliOptions) => Promise<number>,
): (options: CliOptions) => Promise<number> {
  return async (options) => {
    if (options.dryRun) {
      return run(options);
    }
    await checkAgemonStateDirectoryBeforeRun(false, (line) =>
      console.log(line),
    );
    return withRepositoryRunLock(await resolveRepositoryRootFor(options), () =>
      run(options),
    );
  };
}

async function runUpgradeCommand(
  requestedVersion: string | undefined,
  options: CliOptions,
): Promise<number> {
  if (options.rollback && (requestedVersion !== undefined || options.print)) {
    throw new Error("--rollback takes no version and no --print.");
  }
  assertNotRootOnMacOS();
  assertRootUsesItsOwnEnvironment();
  const method = await resolveInstallMethod();
  if (options.rollback) {
    return runRollback({ method, yes: Boolean(options.yes) });
  }
  return runUpgrade({
    method,
    runningVersion: VERSION,
    version: requestedVersion,
    print: Boolean(options.print),
    yes: Boolean(options.yes),
  });
}

async function runSelfUninstallCommand(options: CliOptions): Promise<number> {
  assertNotRootOnMacOS();
  assertRootUsesItsOwnEnvironment();
  return runSelfUninstall({
    method: await resolveInstallMethod(),
    yes: Boolean(options.yes),
    dryRun: Boolean(options.dryRun),
    sharedTools: getRegisteredPlugins().flatMap(
      (plugin) => plugin.sharedResources ?? [],
    ),
  });
}

async function runRecover(options: CliOptions): Promise<number> {
  assertNotRootOnMacOS();
  const context = await createContext({
    repoRoot: await resolveRepositoryRootFor(options),
    platform: await detectPlatformCapabilities(),
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: selectSpinner(options),
    verbose: Boolean(options.verbose),
    progress: selectProgress(options),
  });

  await recoverInterruptedApply(context, getRegisteredPlugins(), {
    dryRun: Boolean(options.dryRun),
  });
  return 0;
}

export function exitCodeFor(error: unknown): number {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof ApplyInterruptedError ? cause.exitCode : 1;
}

const EXIT_CODE_HELP = `
Exit codes:
  0    success, nothing to do, preview only, or declined
  1    error, or rolled back
  2    drift found, consent missing, or applied but verification failed
  130  interrupted (143 for SIGTERM)`;

function createProgram(recordExitCode: (code: number) => void): Command {
  const program = new Command();
  const record =
    (run: (options: CliOptions) => Promise<number>) =>
    async (options: CliOptions) =>
      recordExitCode(await run(options));
  const recordWithUpdateCheck =
    (run: (options: CliOptions) => Promise<number>) =>
    async (options: CliOptions) => {
      const pendingUpdate = startUpdateCheck({
        currentVersion: VERSION,
        dryRun: Boolean(options.dryRun),
        quiet: Boolean(options.quiet),
      });
      try {
        const exitCode = await run(options);
        recordExitCode(exitCode);
        if (exitCode === 0) {
          await pendingUpdate?.finish({ yes: Boolean(options.yes) });
        }
      } finally {
        pendingUpdate?.abort();
      }
    };

  program
    .name("agemon")
    .description(DESCRIPTION)
    .version(VERSION)
    .option("--dry-run", "narrate actions without making changes")
    .option("--yes", "skip confirmation prompts")
    .option("--skip-daemon", "skip daemon registration")
    .option(
      "--allow-unignored-state",
      "let apply write .agemon/ state even when it cannot be git-ignored (discouraged)",
    )
    .option(
      "--only <plugins>",
      "comma-separated list of plugin ids to run (their dependencies run too, e.g. agents runs skills)",
    )
    .option(
      "--skill-groups <groups>",
      "comma-separated skill group ids to install, or 'all'/'none' (default: interactive prompt per group, or essentials-only when non-interactive)",
    )
    .option("--no-color", "disable colored output")
    .option("-v, --verbose", "show raw subprocess output beneath each step")
    .option("-q, --quiet", "print only the final summary")
    .addHelpText("beforeAll", () => `${renderBanner("agemon", DESCRIPTION)}\n`)
    .addHelpText("after", EXIT_CODE_HELP)
    .hook("preAction", (thisCommand) => {
      if (thisCommand.opts().color === false) {
        process.env.NO_COLOR = "1";
      }
    })
    .action(
      refusingUnsupportedPlatforms(
        recordWithUpdateCheck(lockingTheRepository(runInstall)),
      ),
    );

  program
    .command("inspect")
    .description(
      "Read-only inventory + eight-state classification + duplication report",
    )
    .option("--json", "emit the redacted JSON report instead of a table")
    .option(
      "--check-agents-usable",
      "run a non-mutating usability probe for detected coding agents",
    )
    .action((_options: CliOptions, command: Command) =>
      record(runInspectCommand)({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program
    .command("status")
    .description(
      "Post-install health + drift summary from the provenance ledger",
    )
    .action((_options: CliOptions, command: Command) =>
      record(runStatusCommand)({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program
    .command("plan")
    .description(
      "Deterministic, fingerprinted proposed-operation set written to .agemon/plans/",
    )
    .option(
      "--only <plugins>",
      "comma-separated list of plugin ids to run (their dependencies run too, e.g. agents runs skills)",
    )
    .option(
      "--skill-groups <groups>",
      "comma-separated skill group ids to install, or 'all'/'none'",
    )
    .action((_options: CliOptions, command: Command) =>
      record(runPlanCommand)({ ...command.parent?.opts(), ...command.opts() }),
    );

  program
    .command("apply")
    .description("Run a confirmed plan transactionally")
    .option("--plan <id>", "apply a specific persisted plan id")
    .option("--yes", "skip confirmation prompts")
    .option("--skip-daemon", "skip daemon registration")
    .option(
      "--allow-unignored-state",
      "write .agemon/ state even when it cannot be git-ignored (discouraged)",
    )
    .option(
      "--only <plugins>",
      "comma-separated list of plugin ids to run (their dependencies run too, e.g. agents runs skills)",
    )
    .action((_options: CliOptions, command: Command) =>
      refusingUnsupportedPlatforms(
        recordWithUpdateCheck(lockingTheRepository(runApply)),
      )({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program
    .command("nuke")
    .description("Reverse agemon-managed changes")
    .option("--dry-run", "narrate actions without making changes")
    .option("--yes", "skip confirmation prompts")
    .option("--skip-daemon", "keep the daemon (and what it needs) installed")
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
    .option(
      "--remove-shared <tools>",
      "also remove these shared tools agemon installed before it tracked them per machine (code-review-graph, agnix)",
    )
    .action((_options: CliOptions, command: Command) =>
      refusingUnsupportedPlatforms(
        recordWithUpdateCheck(lockingTheRepository(runNuke)),
      )({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program
    .command("recover")
    .description("Restore the files an interrupted apply changed")
    .option(
      "--dry-run",
      "show what would be restored without changing anything",
    )
    .option("--yes", "restore without asking")
    .addHelpText("after", `\n${RECOVER_LIMIT_NOTE}`)
    .action((_options: CliOptions, command: Command) =>
      record(lockingTheRepository(runRecover))({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program
    .command("upgrade")
    .description(
      "Install the latest agemon release (or the given version), the way this copy was installed",
    )
    .argument(
      "[version]",
      "release to install instead of the latest, e.g. 4.8.0",
    )
    .option(
      "--print",
      "print the verified install steps instead of running them (npm installs)",
    )
    .option(
      "--rollback",
      "switch back to the install the last upgrade replaced (install-script installs)",
    )
    .option("--yes", "skip confirmation prompts")
    .action(
      (
        requestedVersion: string | undefined,
        _options: CliOptions,
        command: Command,
      ) =>
        record((options) => runUpgradeCommand(requestedVersion, options))({
          ...command.parent?.opts(),
          ...command.opts(),
        }),
    );

  program
    .command("self-uninstall")
    .description(
      "Remove agemon itself from this machine (never touches repositories)",
    )
    .option("--dry-run", "show what would be removed without removing it")
    .option("--yes", "remove without asking")
    .action((_options: CliOptions, command: Command) =>
      record(runSelfUninstallCommand)({
        ...command.parent?.opts(),
        ...command.opts(),
      }),
    );

  program.exitOverride();

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  let exitCode = 0;
  const program = createProgram((code) => {
    exitCode = code;
  });

  try {
    assertFakeBackendsAreDevOnly();
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    console.error(
      renderCliError(error instanceof Error ? error.message : String(error)),
    );
    return exitCodeFor(error);
  }
}

const isDirectlyExecuted =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyExecuted) {
  process.exitCode = await runCli(process.argv.slice(2));
}
