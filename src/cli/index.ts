import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { createContext } from "../core/context.js";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
import { installPlugins, uninstallPlugins } from "../core/orchestrator.js";
import { getRegisteredPlugins } from "../plugins/index.js";
import { renderBanner } from "../ui/banner.js";
import { createStepSpinner } from "../ui/spinner.js";
import { theme } from "../ui/theme.js";

const PACKAGE_JSON_SEARCH_DEPTH = 5;

// This file's own directory differs between dev (src/cli/index.ts, run via
// tsx) and the built/installed layout (dist/index.js, one level closer to
// the package root) — walk up until the nearest package.json is found
// rather than hardcoding a relative path that would only match one of them.
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
}

async function runInstall(options: CliOptions): Promise<void> {
  const spinner = createStepSpinner();
  const plugins = getRegisteredPlugins().filter(
    (plugin) => !(options.skipDaemon && plugin.id === "daemon"),
  );
  const context = await createContext({
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    ui: spinner,
  });

  await installPlugins(context, plugins, { only: options.only });
}

async function runNuke(options: CliOptions): Promise<void> {
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
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
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
    .command("nuke")
    .description("Reverse agemon-managed changes")
    .option("--dry-run", "narrate actions without making changes")
    .option("--yes", "skip confirmation prompts")
    .option("--only <plugins>", "comma-separated list of plugin ids to run")
    .action((options: CliOptions) => runNuke(options));

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
