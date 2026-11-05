import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { Command, CommanderError } from "commander";
import {
  addCapabilitiesToConfig,
  findCapabilityOffers,
  outcomeUpdatesConfig,
  promptForNewCapabilities,
} from "../core/capability-migration.js";
import {
  type AgemonConfig,
  type CustomSkillGroupConfig,
  loadConfig,
  SKILL_GROUPS_WHEN_ABSENT,
} from "../core/config.js";
import { type Context, createContext } from "../core/context.js";
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
import { describeOffers, findOffers } from "../core/offers.js";
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
import {
  assertCustomSkillGroupsAreValid,
  findSkillGroup,
} from "../plugins/skills/catalog.js";
import { SKILLS_PLUGIN_ID } from "../plugins/skills/ledger-view.js";
import type { AgemonPlugin, Offer } from "../plugins/types.js";
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
const TRUST_REPO_GIT_CONFIG_HELP =
  "with --yes, approve installing code-review-graph and its daemon in a repository whose own git config has keys agemon does not trust by default (the keys are always printed; read them first)";

interface CliOptions {
  dryRun?: boolean;
  yes?: boolean;
  only?: string;
  skipDaemon?: boolean;
  skillGroups?: string;
  json?: boolean;
  allowUnignoredState?: boolean;
  trustRepoGitConfig?: boolean;
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
    match:
      /^Refusing to write \.agemon\/ state: \/\.agemon\/ is not git-ignored\./,
    hint: "add /.agemon/ to .gitignore, or re-run interactively or with --yes; if agemon reported that git could not answer, fix that git error first.",
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

interface DesiredStateDefaults {
  config: AgemonConfig | null;
  only: string[] | undefined;
  skillGroups: string | undefined;
  customSkillGroups: CustomSkillGroupConfig[];
}

interface CapabilityChoice {
  chosenIds: string[];
  leftOutIds: string[];
}

const NO_CAPABILITY_CHOICE: CapabilityChoice = {
  chosenIds: [],
  leftOutIds: [],
};

function quoteCapabilityIds(capabilityIds: string[]): string {
  return capabilityIds.map((id) => `'${id}'`).join(", ");
}

function canAskAboutNewCapabilities(options: CliOptions): boolean {
  return (
    isInteractiveTerminal() &&
    !options.yes &&
    !options.dryRun &&
    !options.plan &&
    options.only === undefined
  );
}

async function chooseNewCapabilities(
  options: CliOptions,
  config: AgemonConfig | null,
  plugins: AgemonPlugin[],
): Promise<CapabilityChoice> {
  if (config === null || !canAskAboutNewCapabilities(options)) {
    return NO_CAPABILITY_CHOICE;
  }
  const newIds = findCapabilityOffers(config, plugins)
    .filter((offer) => offer.state === "new")
    .map((offer) => offer.id);
  if (newIds.length === 0) {
    return NO_CAPABILITY_CHOICE;
  }
  const chosenIds = await promptForNewCapabilities(
    plugins.filter((plugin) => newIds.includes(plugin.id)),
  );
  return {
    chosenIds,
    leftOutIds: newIds.filter((id) => !chosenIds.includes(id)),
  };
}

function describeCapabilityChoice({
  chosenIds,
  leftOutIds,
}: CapabilityChoice): string {
  return [
    ...(chosenIds.length > 0
      ? [
          `added ${quoteCapabilityIds(chosenIds)} to capabilities; remove it there to opt out`,
        ]
      : []),
    ...(leftOutIds.length > 0
      ? [
          `left ${quoteCapabilityIds(leftOutIds)} out; 'agemon add <name>' installs it later`,
        ]
      : []),
  ].join("; ");
}

async function updateConfigWithCapabilityChoice(
  repoRoot: string,
  config: AgemonConfig,
  choice: CapabilityChoice,
  allowUnignoredState: boolean,
): Promise<string> {
  const update = await addCapabilitiesToConfig(
    repoRoot,
    config,
    choice.chosenIds,
    { knownCapabilities: CORE_CAPABILITY_IDS, allowUnignoredState },
  );
  if (update.kind === "state-not-ignored") {
    return "Left agemon.toml unchanged: /.agemon/ is not git-ignored, so agemon keeps no backup of it there. Add /.agemon/ to .gitignore (or pass --allow-unignored-state) and run agemon again to record this choice.";
  }
  if (update.kind === "not-written") {
    return `Left agemon.toml unchanged: ${update.reason}. The next run asks again.`;
  }
  const savedOriginal =
    update.backupPath === null
      ? ""
      : ` Comments and layout were not kept; the original is saved at ${update.backupPath} (a full 'agemon nuke' deletes .agemon/, so keep a copy if you need it).`;
  return `Updated agemon.toml: ${describeCapabilityChoice(choice)}.${savedOriginal} Commit agemon.toml; older agemon versions reject it, so upgrade agemon in CI first.`;
}

async function recordCapabilityChoice(
  repoRoot: string,
  config: AgemonConfig | null,
  choice: CapabilityChoice,
  run: { outcome: RunOutcome; allowUnignoredState: boolean },
): Promise<void> {
  if (
    config === null ||
    (choice.chosenIds.length === 0 && choice.leftOutIds.length === 0)
  ) {
    return;
  }
  if (!outcomeUpdatesConfig(run.outcome)) {
    console.log(
      "Left agemon.toml unchanged: this run applied nothing that was approved. The next run asks again.",
    );
    return;
  }
  console.log(
    await updateConfigWithCapabilityChoice(
      repoRoot,
      config,
      choice,
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

  const excludedIds = excludedPluginIds(options);
  const configuredIds = config?.capabilities.filter(
    (id) => !excludedIds.includes(id),
  );

  return {
    config,
    only: parseOnlyOption(options) ?? configuredIds,
    skillGroups: options.skillGroups ?? config?.skillGroups ?? undefined,
    customSkillGroups: config?.customSkillGroups ?? [],
  };
}

function withChosenCapabilities(
  only: string[] | undefined,
  choice: CapabilityChoice,
): string[] | undefined {
  return only?.concat(choice.chosenIds);
}

interface ReportConfig {
  config: AgemonConfig | null;
  customSkillGroups: CustomSkillGroupConfig[];
  configError: string | null;
}

async function loadConfigForReport(repoRoot: string): Promise<ReportConfig> {
  try {
    const config = await loadConfig(repoRoot);
    const customSkillGroups = config?.customSkillGroups ?? [];
    assertCustomSkillGroupsAreValid(customSkillGroups);
    return { config, customSkillGroups, configError: null };
  } catch (error) {
    return {
      config: null,
      customSkillGroups: [],
      configError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function reportOffers(
  options: CliOptions,
  context: Context,
  plugins: AgemonPlugin[],
): Promise<void> {
  if (options.quiet) {
    return;
  }
  const { config } = await loadConfigForReport(context.cwd);
  for (const line of describeOffers(findOffers(context, plugins, config))) {
    console.log(theme.dim(line));
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
  const { config, customSkillGroups, configError } =
    await loadConfigForReport(repoRoot);
  const platform = await detectPlatformCapabilities();
  const unrunnableIds = findWhatThisMachineCannotRun(options, platform).map(
    ({ id }) => id,
  );
  const context = await createContext({
    repoRoot,
    platform,
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
    customSkillGroups,
  });

  const report = await runStatus(context, getRegisteredPlugins(), {
    configError,
    config,
    offerablePlugins: getRegisteredPlugins().filter(
      (plugin) => !unrunnableIds.includes(plugin.id),
    ),
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
  const { only, skillGroups, customSkillGroups } =
    await resolveDesiredStateDefaults(options, repoRoot);
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
  await reportOffers(options, context, plugins);
  return 0;
}

async function runInstall(requested: CliOptions): Promise<number> {
  const platform = await detectPlatformCapabilities();
  const options = skippingWhatThisMachineCannotRun(requested, platform);
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const { config, only, skillGroups, customSkillGroups } =
    await resolveDesiredStateDefaults(options, repoRoot);
  const dryRun = Boolean(options.dryRun);
  openInteractiveFrame(options);
  let choice: CapabilityChoice;
  let context: Context;
  let outcome: RunOutcome;
  try {
    choice = await chooseNewCapabilities(options, config, plugins);
    context = await createContext({
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
      only: withChosenCapabilities(only, choice),
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      trustRepoGitConfig: Boolean(options.trustRepoGitConfig),
      conflictDecisions: config?.conflictDecisions,
      persistConfig: config === null,
      platformSkippedCapabilities: options.platformSkippedIds ?? [],
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  await recordCapabilityChoice(repoRoot, config, choice, {
    outcome,
    allowUnignoredState: Boolean(options.allowUnignoredState),
  });
  if (config !== null) {
    await reportOffers(options, context, plugins);
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
  const { config, only, skillGroups, customSkillGroups } =
    await resolveDesiredStateDefaults(options, repoRoot);
  openInteractiveFrame(options);
  let choice: CapabilityChoice;
  let context: Context;
  let outcome: RunOutcome;
  try {
    choice = await chooseNewCapabilities(options, config, plugins);
    context = await createContext({
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
      only: withChosenCapabilities(only, choice),
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      trustRepoGitConfig: Boolean(options.trustRepoGitConfig),
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
  await recordCapabilityChoice(repoRoot, config, choice, {
    outcome,
    allowUnignoredState: Boolean(options.allowUnignoredState),
  });
  if (config !== null) {
    await reportOffers(options, context, plugins);
  }
  return exitCodeForOutcome(outcome);
}

const OUTCOMES_THAT_INSTALLED_THE_ADDITION: ReadonlySet<RunOutcome> = new Set([
  "applied",
  "nothing-to-do",
  "partial",
]);

function explainNothingToAdd(name: string, config: AgemonConfig): string {
  const capability = getRegisteredPlugins().find(
    (plugin) => plugin.id === name,
  );
  if (capability !== undefined) {
    if (config.capabilities.includes(name)) {
      return `'${name}' is already enabled.`;
    }
    const missingIds = (capability.dependsOn ?? []).filter(
      (id) => !config.capabilities.includes(id),
    );
    throw new Error(
      missingIds.length > 0
        ? `'${name}' needs ${missingIds.join(", ")}; run 'agemon add ${missingIds.join(" ")}' first.`
        : `'${name}' cannot run here.`,
    );
  }
  const isSkillGroup =
    findSkillGroup(name) !== undefined ||
    config.customSkillGroups.some((group) => group.id === name);
  if (!isSkillGroup) {
    throw new Error(
      `Unknown capability or skill group '${printable(name)}'. 'agemon status' lists what can be added.`,
    );
  }
  if (!config.capabilities.includes(SKILLS_PLUGIN_ID)) {
    throw new Error(
      `Skill group '${printable(name)}' needs skills; run 'agemon add ${SKILLS_PLUGIN_ID}' first.`,
    );
  }
  return `Skill group '${printable(name)}' is already installed.`;
}

function resolveAdditions(
  names: string[],
  offers: Offer[],
  config: AgemonConfig,
): { capabilityIds: string[]; skillGroupIds: string[]; notes: string[] } {
  const capabilityIds: string[] = [];
  const skillGroupIds: string[] = [];
  const notes: string[] = [];
  for (const name of new Set(names)) {
    const matches = offers.filter((offer) => offer.id === name);
    if (matches.length > 1) {
      throw new Error(
        `'${printable(name)}' names both a capability and a skill group; rename the skill group in agemon.toml.`,
      );
    }
    const [offer] = matches;
    if (offer === undefined) {
      notes.push(explainNothingToAdd(name, config));
    } else if (offer.kind === "capability") {
      capabilityIds.push(name);
    } else {
      skillGroupIds.push(name);
    }
  }
  return { capabilityIds, skillGroupIds, notes };
}

function capabilitiesInstallingSkillGroups(
  config: AgemonConfig,
  plugins: AgemonPlugin[],
): string[] {
  return [
    SKILLS_PLUGIN_ID,
    ...plugins
      .filter(
        (plugin) =>
          config.capabilities.includes(plugin.id) &&
          plugin.dependsOn?.includes(SKILLS_PLUGIN_ID),
      )
      .map((plugin) => plugin.id),
  ];
}

async function runAdd(names: string[], requested: CliOptions): Promise<number> {
  if (requested.dryRun) {
    throw new Error(
      "'agemon add' has no --dry-run; it shows what it will change and asks first.",
    );
  }
  const platform = await detectPlatformCapabilities();
  const options = skippingWhatThisMachineCannotRun(requested, platform);
  const repoRoot = await resolveRepositoryRootFor(options);
  const { config, skillGroups, customSkillGroups } =
    await resolveDesiredStateDefaults(options, repoRoot);
  if (config === null) {
    throw new Error(
      "This repository has no agemon.toml. Run 'agemon' first, then 'agemon add'.",
    );
  }
  const plugins = selectPlugins(options);
  const scanContext = await createContext({
    repoRoot,
    platform,
    dryRun: false,
    yes: Boolean(options.yes),
    ui: selectSpinner(options),
    verbose: Boolean(options.verbose),
    progress: selectProgress(options),
    skillGroups,
    customSkillGroups,
  });
  const { capabilityIds, skillGroupIds, notes } = resolveAdditions(
    names,
    findOffers(scanContext, plugins, config),
    config,
  );
  for (const note of notes) {
    console.log(note);
  }
  if (capabilityIds.length === 0 && skillGroupIds.length === 0) {
    return 0;
  }

  const context: Context = {
    ...scanContext,
    requestedSkillGroupIds: new Set(skillGroupIds),
  };
  openInteractiveFrame(options);
  let outcome: RunOutcome;
  try {
    outcome = await reconcile(context, plugins, {
      only: [
        ...new Set([
          ...capabilityIds,
          ...(skillGroupIds.length > 0
            ? capabilitiesInstallingSkillGroups(config, plugins)
            : []),
        ]),
      ],
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      trustRepoGitConfig: Boolean(options.trustRepoGitConfig),
      conflictDecisions: config.conflictDecisions,
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  const approvable = Boolean(options.yes) || isInteractiveTerminal();
  if (capabilityIds.length > 0) {
    if (approvable && OUTCOMES_THAT_INSTALLED_THE_ADDITION.has(outcome)) {
      console.log(
        await updateConfigWithCapabilityChoice(
          repoRoot,
          config,
          { chosenIds: capabilityIds, leftOutIds: [] },
          Boolean(options.allowUnignoredState),
        ),
      );
    } else {
      console.log(
        "Left agemon.toml unchanged: this run applied nothing that was approved.",
      );
    }
  }
  await reportOffers(options, context, plugins);
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

export function createProgram(recordExitCode: (code: number) => void): Command {
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
    .option("--trust-repo-git-config", TRUST_REPO_GIT_CONFIG_HELP)
    .option(
      "--only <plugins>",
      "comma-separated list of plugin ids to run (their dependencies run too, e.g. agents runs skills)",
    )
    .option(
      "--skill-groups <groups>",
      `comma-separated skill group ids to install, or 'all'/'none' (default: ${SKILL_GROUPS_WHEN_ABSENT})`,
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
    .option("--trust-repo-git-config", TRUST_REPO_GIT_CONFIG_HELP)
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
    .command("add")
    .description(
      "Install a capability or skill group this repository left out or has not chosen yet",
    )
    .argument("<names...>", "capability or skill group names")
    .option("--yes", "skip confirmation prompts")
    .option(
      "--allow-unignored-state",
      "write .agemon/ state even when it cannot be git-ignored (discouraged)",
    )
    .option("--trust-repo-git-config", TRUST_REPO_GIT_CONFIG_HELP)
    .action((names: string[], _options: CliOptions, command: Command) =>
      refusingUnsupportedPlatforms(
        record(lockingTheRepository((options) => runAdd(names, options))),
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
