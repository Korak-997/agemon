import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteContentError } from "./error.js";

const HELP_TIMEOUT_MS = 10_000;
const MAX_HELP_OUTPUT_BYTES = 1024 * 1024;

const COMMAND_NAME_PATTERN = /^[a-z][a-z-]*$/u;
const COMMANDS_SECTION_HEADER = "Commands:";
const USAGE_LINE_PREFIX = "Usage:";

export type HelpRunner = (commandArguments: readonly string[]) => string;

export function createHelpRunner(nodeArguments: readonly string[]): HelpRunner {
  return (commandArguments) => {
    const scratchDirectory = mkdtempSync(join(tmpdir(), "agemon-site-help-"));
    try {
      return execFileSync(
        process.execPath,
        [...nodeArguments, ...commandArguments, "--help"],
        {
          cwd: scratchDirectory,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: scratchDirectory,
            NO_COLOR: "1",
          },
          encoding: "utf8",
          timeout: HELP_TIMEOUT_MS,
          maxBuffer: MAX_HELP_OUTPUT_BYTES,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } finally {
      rmSync(scratchDirectory, { recursive: true, force: true });
    }
  };
}

export interface CommandHelp {
  name: string;
  help: string;
}

export interface CliHelp {
  root: string;
  commands: CommandHelp[];
}

function listedCommandNames(rootHelp: string): string[] {
  const lines = rootHelp.split("\n");
  const header = lines.findIndex(
    (line) => line.trim() === COMMANDS_SECTION_HEADER,
  );
  if (header === -1) {
    throw new SiteContentError(
      `agemon --help has no "${COMMANDS_SECTION_HEADER}" section`,
    );
  }
  const names: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith("  ")) break;
    const isContinuationOfDescription = line.startsWith("   ");
    if (isContinuationOfDescription) continue;
    const name = line.trim().split(/\s+/u)[0];
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new SiteContentError(
        `agemon --help lists an unexpected command name ${JSON.stringify(name)}`,
      );
    }
    names.push(name);
  }
  if (names.length === 0) {
    throw new SiteContentError("agemon --help lists no commands");
  }
  return names;
}

function withoutBanner(help: string, command: string): string {
  const usageStart = help.indexOf(USAGE_LINE_PREFIX);
  if (usageStart === -1) {
    throw new SiteContentError(
      `agemon ${command} --help has no "${USAGE_LINE_PREFIX}" line`,
    );
  }
  return help.slice(usageStart).trimEnd();
}

export function collectCliHelp(runHelp: HelpRunner): CliHelp {
  const root = runHelp([]).trimEnd();
  const commands = listedCommandNames(root).map((name) => ({
    name,
    help: withoutBanner(runHelp([name]), name),
  }));
  return { root, commands };
}
