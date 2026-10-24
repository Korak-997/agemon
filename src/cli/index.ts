import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { Command, CommanderError } from "commander";
import { type AgemonConfig, loadConfig } from "../core/config.js";
import { createContext } from "../core/context.js";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
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
import { printable } from "../core/untrusted-text.js";
import { startUpdateCheck } from "../core/update-check.js";
import { runInspect } from "../inspect/index.js";
import { runStatus } from "../inspect/status.js";
import { getRegisteredPlugins } from "../plugins/index.js";
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

const PACKAGE_JSON_SEARCH_DEPTH = 5;

function resolvePackageVersion(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < PACKAGE_JSON_SEARCH_DEPTH; depth += 1) {
    try {
      const contents = readFileSync(join(currentDir, "package.json"), "utf8");
      return JSON.parse(contents).version;
    } catch {
      currentDir = join(currentDir, "..");
    }
  }
  throw new Error(
    "Unable to locate agemon's package.json to resolve its version.",
  );
}

const VERSION = resolvePackageVersion();
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

function selectPlugins(options: CliOptions): AgemonPlugin[] {
  return getRegisteredPlugins().filter(
    (plugin) => !(options.skipDaemon && plugin.id === "daemon"),
  );
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
}

async function resolveDesiredStateDefaults(
  options: CliOptions,
  repoRoot: string,
): Promise<DesiredStateDefaults> {
  const config = await loadConfig(repoRoot);
  if (config) {
    assertConfiguredCapabilitiesAreKnown(config);
  }

  const configuredIds = config?.capabilities.filter(
    (id) => !(options.skipDaemon && id === "daemon"),
  );

  return {
    config,
    only: parseOnlyOption(options) ?? configuredIds,
    skillGroups: options.skillGroups ?? config?.skillGroups ?? undefined,
  };
}

async function runInspectCommand(options: CliOptions): Promise<number> {
  const context = await createContext({
    repoRoot: await resolveRepositoryRootFor(options),
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
  });

  await runInspect(context, {
    json: Boolean(options.json),
    checkAgentsUsable: Boolean(options.checkAgentsUsable),
  });
  return 0;
}

async function runStatusCommand(options: CliOptions): Promise<number> {
  const context = await createContext({
    repoRoot: await resolveRepositoryRootFor(options),
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
  });

  const report = await runStatus(context, getRegisteredPlugins());
  return report.healthy || !report.hasAgemonState
    ? 0
    : exitCodeForOutcome("drift");
}

async function runPlanCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const plugins = selectPlugins(options);
  const { only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    repoRoot,
  );
  const context = await createContext({
    repoRoot,
    dryRun: true,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
    skillGroups,
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

async function runInstall(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    repoRoot,
  );
  openInteractiveFrame(options);
  let outcome: RunOutcome;
  try {
    const context = await createContext({
      repoRoot,
      dryRun: Boolean(options.dryRun),
      yes: Boolean(options.yes),
      ui: spinner,
      verbose: Boolean(options.verbose),
      progress: selectProgress(options),
      skillGroups,
    });

    outcome = await reconcile(context, plugins, {
      only,
      agemonVersion: VERSION,
      allowUnignoredState: Boolean(options.allowUnignoredState),
      conflictDecisions: config?.conflictDecisions,
      persistConfig: config === null,
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  return exitCodeForOutcome(outcome);
}

async function runApply(options: CliOptions): Promise<number> {
  if (options.plan) {
    assertValidPlanId(options.plan);
  }
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    repoRoot,
  );
  openInteractiveFrame(options);
  let outcome: RunOutcome;
  try {
    const context = await createContext({
      repoRoot,
      dryRun: false,
      yes: Boolean(options.yes),
      ui: spinner,
      verbose: Boolean(options.verbose),
      progress: selectProgress(options),
      skillGroups,
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
    });
  } catch (error) {
    closeInteractiveFrame(options, "failure");
    throw error;
  }
  closeInteractiveFrame(options);
  return exitCodeForOutcome(outcome);
}

async function runNuke(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepositoryRootFor(options);
  const spinner = selectSpinner(options);
  const plugins = getRegisteredPlugins();
  const context = await createContext({
    repoRoot,
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
    verbose: Boolean(options.verbose),
    progress: selectProgress(options),
  });

  const outcome = await uninstallPlugins(context, plugins, {
    only: parseOnlyOption(options),
    skipIds: options.skipDaemon ? ["daemon"] : [],
  });
  return exitCodeForOutcome(outcome);
}

async function runRecover(options: CliOptions): Promise<number> {
  const context = await createContext({
    repoRoot: await resolveRepositoryRootFor(options),
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
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
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
    .action(recordWithUpdateCheck(runInstall));

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
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
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
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
    .action((_options: CliOptions, command: Command) =>
      recordWithUpdateCheck(runApply)({
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
    .action((_options: CliOptions, command: Command) =>
      recordWithUpdateCheck(runNuke)({
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
      record(runRecover)({ ...command.parent?.opts(), ...command.opts() }),
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
