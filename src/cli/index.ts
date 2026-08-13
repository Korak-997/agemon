import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";
import { plugins } from "../plugins/index.js";
import { renderBanner } from "../ui/banner.js";
import { createStepSpinner } from "../ui/spinner.js";
import { theme } from "../ui/theme.js";

const VERSION = "0.1.0";
const DESCRIPTION =
  "Bootstraps and reverses an AI coding agent's working environment in a repo.";

async function runInstall(): Promise<void> {
  const spinner = createStepSpinner();
  spinner.start("Checking registered plugins");

  if (plugins.length === 0) {
    spinner.succeed("Nothing to do — no plugins registered yet.");
    return;
  }

  // Phase 1 introduces the orchestrator that walks `plugins` here,
  // resolving `dependsOn` and threading a `Context` through each one.
  spinner.fail("No orchestrator wired up yet.");
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
    .action(runInstall);

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
