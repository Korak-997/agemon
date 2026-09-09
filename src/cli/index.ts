import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { Command, CommanderError } from "commander";
import { type AgemonConfig, loadConfig } from "../core/config.js";
import { createContext } from "../core/context.js";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
import {
  buildPlan,
  reconcile,
  uninstallPlugins,
} from "../core/orchestrator.js";
import { readPlan, writePlan } from "../core/plan-store.js";
import { isInteractiveTerminal } from "../core/prompt.js";
import { checkForUpdate } from "../core/update-check.js";
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
}

const SILENT_SPINNER: StepSpinner = {
  start() {},
  succeed() {},
  fail() {},
  info() {},
};

function selectSpinner(options: CliOptions): StepSpinner {
  return options.quiet ? SILENT_SPINNER : createStepSpinner();
}

function selectProgress(options: CliOptions): StepProgress {
  return options.quiet ? SILENT_PROGRESS : createStepProgress();
}

function openInteractiveFrame(options: CliOptions): void {
  if (!options.quiet && isInteractiveTerminal()) {
    intro(theme.heading(`agemon ${VERSION}`));
  }
}

function closeInteractiveFrame(options: CliOptions): void {
  if (!options.quiet && isInteractiveTerminal()) {
    outro(theme.ok("done"));
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
];

function renderCliError(message: string): string {
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

interface DesiredStateDefaults {
  config: AgemonConfig | null;
  only: string | undefined;
  skillGroups: string | undefined;
}

async function resolveDesiredStateDefaults(
  options: CliOptions,
  availablePlugins: AgemonPlugin[],
): Promise<DesiredStateDefaults> {
  const config = await loadConfig(process.cwd());

  let only = options.only;
  if (!only && config) {
    const availableIds = new Set(availablePlugins.map((plugin) => plugin.id));
    const configuredIds = config.capabilities.filter((id) =>
      availableIds.has(id),
    );
    only = configuredIds.length > 0 ? configuredIds.join(",") : undefined;
  }

  return {
    config,
    only,
    skillGroups: options.skillGroups ?? config?.skillGroups ?? undefined,
  };
}

async function runInspectCommand(options: CliOptions): Promise<void> {
  const context = await createContext({
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
  });

  await runInspect(context, { json: Boolean(options.json) });
}

async function runStatusCommand(options: CliOptions): Promise<void> {
  const context = await createContext({
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
    progress: SILENT_PROGRESS,
  });

  await runStatus(context, getRegisteredPlugins());
}

async function runPlanCommand(options: CliOptions): Promise<void> {
  const plugins = selectPlugins(options);
  const { only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    plugins,
  );
  const context = await createContext({
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
}

async function runInstall(options: CliOptions): Promise<void> {
  const didUpdate = await checkForUpdate({
    currentVersion: VERSION,
    dryRun: Boolean(options.dryRun),
  });
  if (didUpdate) {
    return;
  }

  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    plugins,
  );
  openInteractiveFrame(options);
  const context = await createContext({
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
    progress: selectProgress(options),
    skillGroups,
  });

  await reconcile(context, plugins, {
    only,
    agemonVersion: VERSION,
    allowUnignoredState: Boolean(options.allowUnignoredState),
    conflictDecisions: config?.conflictDecisions,
    persistConfig: config === null,
  });
  closeInteractiveFrame(options);
}

async function runApply(options: CliOptions): Promise<void> {
  const didUpdate = await checkForUpdate({
    currentVersion: VERSION,
    dryRun: false,
  });
  if (didUpdate) {
    return;
  }

  const spinner = selectSpinner(options);
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    plugins,
  );
  openInteractiveFrame(options);
  const context = await createContext({
    dryRun: false,
    yes: Boolean(options.yes),
    ui: spinner,
    progress: selectProgress(options),
    skillGroups,
  });

  const plan = options.plan
    ? await readPlan(context.cwd, options.plan)
    : undefined;

  await reconcile(context, plugins, {
    only,
    agemonVersion: VERSION,
    allowUnignoredState: Boolean(options.allowUnignoredState),
    plan,
    conflictDecisions: config?.conflictDecisions,
    persistConfig: config === null,
  });
  closeInteractiveFrame(options);
}

async function runNuke(options: CliOptions): Promise<void> {
  const didUpdate = await checkForUpdate({
    currentVersion: VERSION,
    dryRun: Boolean(options.dryRun),
  });
  if (didUpdate) {
    return;
  }

  const spinner = selectSpinner(options);
  const plugins = getRegisteredPlugins();
  const context = await createContext({
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
    progress: selectProgress(options),
  });

  await uninstallPlugins(context, plugins, { only: options.only });
}

function createProgram(): Command {
  const program = new Command();

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
    .hook("preAction", (thisCommand) => {
      if (thisCommand.opts().color === false) {
        process.env.NO_COLOR = "1";
      }
    })
    .action((options: CliOptions) => runInstall(options));

  program
    .command("inspect")
    .description(
      "Read-only inventory + eight-state classification + duplication report",
    )
    .option("--json", "emit the redacted JSON report instead of a table")
    .action((_options: CliOptions, command: Command) =>
      runInspectCommand({ ...command.parent?.opts(), ...command.opts() }),
    );

  program
    .command("status")
    .description(
      "Post-install health + drift summary from the provenance ledger",
    )
    .action((_options: CliOptions, command: Command) =>
      runStatusCommand({ ...command.parent?.opts(), ...command.opts() }),
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
      runPlanCommand({ ...command.parent?.opts(), ...command.opts() }),
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
      runApply({ ...command.parent?.opts(), ...command.opts() }),
    );

  program
    .command("nuke")
    .description("Reverse agemon-managed changes")
    .option("--dry-run", "narrate actions without making changes")
    .option("--yes", "skip confirmation prompts")
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
    .action((_options: CliOptions, command: Command) =>
      runNuke({ ...command.parent?.opts(), ...command.opts() }),
    );

  program.exitOverride();

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  const program = createProgram();

  try {
    assertFakeBackendsAreDevOnly();
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    console.error(
      renderCliError(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

const isDirectlyExecuted =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyExecuted) {
  process.exitCode = await runCli(process.argv.slice(2));
}
