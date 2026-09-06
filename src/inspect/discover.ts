import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "../core/context.js";
import { isDenylistedPath } from "./redact.js";

const execFileAsync = promisify(execFile);

export const ROOT_RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
] as const;

export const STRUCTURED_CONFIG_FILES = [
  ".mcp.json",
  ".claude/settings.json",
  ".gemini/settings.json",
] as const;

const ROOT_COPILOT_INSTRUCTION_FILE = ".github/copilot-instructions.md";
const SCOPED_COPILOT_INSTRUCTION_DIRECTORY = ".github/instructions";
const SCOPED_COPILOT_INSTRUCTION_SUFFIX = ".instructions.md";

export type IsolationStatus = "ignored" | "not-ignored" | "no-gitignore-file";

export interface RuleFileResource {
  kind: "rule-file";
  path: string;
  exists: boolean;
  contents: string | null;
}

export interface CopilotInstructionResource {
  kind: "copilot-instruction";
  path: string;
  exists: boolean;
}

export interface StructuredConfigResource {
  kind: "structured-config";
  path: string;
  exists: boolean;
  parsed: unknown;
  parseError: string | null;
  denylisted: boolean;
}

export interface BinaryResource {
  kind: "binary";
  name: string;
  present: boolean;
}

export interface WorkspaceIsolation {
  status: IsolationStatus;
  trackedAgemonPaths: string[];
}

export interface DiscoveryResult {
  ruleFiles: RuleFileResource[];
  copilotInstructions: CopilotInstructionResource[];
  structuredConfigs: StructuredConfigResource[];
  binaries: BinaryResource[];
  isolation: WorkspaceIsolation;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function discoverStructuredConfig(
  cwd: string,
  relativePath: string,
): Promise<StructuredConfigResource> {
  const contents = await readFileIfExists(join(cwd, relativePath));
  if (contents === null) {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: false,
      parsed: null,
      parseError: null,
      denylisted: false,
    };
  }

  if (isDenylistedPath(relativePath)) {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: true,
      parsed: null,
      parseError: null,
      denylisted: true,
    };
  }

  try {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: true,
      parsed: JSON.parse(contents),
      parseError: null,
      denylisted: false,
    };
  } catch (error) {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: true,
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
      denylisted: false,
    };
  }
}

async function discoverScopedCopilotInstructions(
  cwd: string,
): Promise<CopilotInstructionResource[]> {
  let entries: string[];
  try {
    entries = await readdir(join(cwd, SCOPED_COPILOT_INSTRUCTION_DIRECTORY));
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.endsWith(SCOPED_COPILOT_INSTRUCTION_SUFFIX))
    .sort()
    .map((entry) => ({
      kind: "copilot-instruction" as const,
      path: `${SCOPED_COPILOT_INSTRUCTION_DIRECTORY}/${entry}`,
      exists: true,
    }));
}

async function discoverCopilotInstructions(
  cwd: string,
): Promise<CopilotInstructionResource[]> {
  const instructions: CopilotInstructionResource[] = [];

  if (
    (await readFileIfExists(join(cwd, ROOT_COPILOT_INSTRUCTION_FILE))) !== null
  ) {
    instructions.push({
      kind: "copilot-instruction",
      path: ROOT_COPILOT_INSTRUCTION_FILE,
      exists: true,
    });
  }

  instructions.push(...(await discoverScopedCopilotInstructions(cwd)));
  return instructions;
}

async function readIsolationStatus(cwd: string): Promise<IsolationStatus> {
  const contents = await readFileIfExists(join(cwd, ".gitignore"));
  if (contents === null) {
    return "no-gitignore-file";
  }

  const normalizedEntries = contents
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\//, "").replace(/\/$/, ""));
  return normalizedEntries.includes(".agemon") ? "ignored" : "not-ignored";
}

async function listTrackedAgemonPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--", ".agemon"],
      { encoding: "utf8" },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export async function discoverRepository(
  ctx: Context,
): Promise<DiscoveryResult> {
  const ruleFiles = await Promise.all(
    ROOT_RULE_FILES.map(async (relativePath) => {
      const contents = await readFileIfExists(join(ctx.cwd, relativePath));
      return {
        kind: "rule-file" as const,
        path: relativePath,
        exists: contents !== null,
        contents,
      };
    }),
  );

  const structuredConfigs = await Promise.all(
    STRUCTURED_CONFIG_FILES.map((relativePath) =>
      discoverStructuredConfig(ctx.cwd, relativePath),
    ),
  );

  return {
    ruleFiles,
    copilotInstructions: await discoverCopilotInstructions(ctx.cwd),
    structuredConfigs,
    binaries: ctx.binaries.map((binary) => ({
      kind: "binary" as const,
      name: binary.name,
      present: binary.present,
    })),
    isolation: {
      status: await readIsolationStatus(ctx.cwd),
      trackedAgemonPaths: await listTrackedAgemonPaths(ctx.cwd),
    },
  };
}
