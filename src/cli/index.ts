import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { type AgemonConfig, loadConfig } from "../core/config.js";
import { createContext } from "../core/context.js";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
import {
  buildPlan,
  reconcile,
  uninstallPlugins,
} from "../core/orchestrator.js";
import { readPlan, renderPlan, writePlan } from "../core/plan-store.js";
import { checkForUpdate } from "../core/update-check.js";
import { runInspect } from "../inspect/index.js";
import { runStatus } from "../inspect/status.js";
import { getRegisteredPlugins } from "../plugins/index.js";
import type { AgemonPlugin } from "../plugins/types.js";
import { renderBanner } from "../ui/banner.js";
import { createStepSpinner, type StepSpinner } from "../ui/spinner.js";
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
}

const SILENT_SPINNER: StepSpinner = {
  start() {},
  succeed() {},
  fail() {},
  info() {},
};

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
  });

  await runInspect(context, { json: Boolean(options.json) });
}

async function runStatusCommand(options: CliOptions): Promise<void> {
  const context = await createContext({
    dryRun: false,
    yes: Boolean(options.yes),
    ui: SILENT_SPINNER,
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

  const spinner = createStepSpinner();
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    plugins,
  );
  const context = await createContext({
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
    skillGroups,
  });

  await reconcile(context, plugins, {
    only,
    agemonVersion: VERSION,
    allowUnignoredState: Boolean(options.allowUnignoredState),
    conflictDecisions: config?.conflictDecisions,
    persistConfig: config === null,
  });
}

async function runApply(options: CliOptions): Promise<void> {
  const didUpdate = await checkForUpdate({
    currentVersion: VERSION,
    dryRun: false,
  });
  if (didUpdate) {
    return;
  }

  const spinner = createStepSpinner();
  const plugins = selectPlugins(options);
  const { config, only, skillGroups } = await resolveDesiredStateDefaults(
    options,
    plugins,
  );
  const context = await createContext({
    dryRun: false,
    yes: Boolean(options.yes),
    ui: spinner,
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
}

async function runNuke(options: CliOptions): Promise<void> {
  const didUpdate = await checkForUpdate({
    currentVersion: VERSION,
    dryRun: Boolean(options.dryRun),
  });
  if (didUpdate) {
    return;
  }

  const spinner = createStepSpinner();
  const plugins = getRegisteredPlugins();
  const context = await createContext({
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
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
      theme.error(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

const isDirectlyExecuted =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyExecuted) {
  process.exitCode = await runCli(process.argv.slice(2));
}
