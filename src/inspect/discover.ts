import { readdir } from "node:fs/promises";
import type { Context } from "../core/context.js";
import { RefusedFileError, readRegularFileIfExists } from "../core/files.js";
import {
  gitIgnoresAgemonState,
  gitignoreListsAgemonState,
} from "../core/gitignore.js";
import {
  hasGitEntry,
  resolveInsideRepo,
  resolveRepoDirectory,
} from "../core/repo-paths.js";
import { runRepositoryGit } from "../core/repository-git.js";
import { TRUNCATION_MARKER } from "../core/subprocess-runner.js";
import { printable } from "../core/untrusted-text.js";
import { isDenylistedPath } from "./redact.js";

const GIT_ERROR_MAX_CHARACTERS = 200;

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
  trackingCheckError: string | null;
}

export interface DiscoveryResult {
  ruleFiles: RuleFileResource[];
  copilotInstructions: CopilotInstructionResource[];
  structuredConfigs: StructuredConfigResource[];
  binaries: BinaryResource[];
  isolation: WorkspaceIsolation;
}

type RepoFileRead =
  | { exists: false; contents: null; refusal: null }
  | { exists: true; contents: string; refusal: null }
  | { exists: true; contents: null; refusal: string };

async function readRepoFile(
  cwd: string,
  relativePath: string,
): Promise<RepoFileRead> {
  try {
    const contents = await readRegularFileIfExists(
      await resolveInsideRepo(cwd, relativePath),
    );
    return contents === null
      ? { exists: false, contents: null, refusal: null }
      : { exists: true, contents, refusal: null };
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return { exists: true, contents: null, refusal: error.message };
    }
    throw error;
  }
}

async function discoverStructuredConfig(
  cwd: string,
  relativePath: string,
): Promise<StructuredConfigResource> {
  const { exists, contents, refusal } = await readRepoFile(cwd, relativePath);
  if (!exists) {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: false,
      parsed: null,
      parseError: null,
      denylisted: false,
    };
  }

  if (refusal !== null) {
    return {
      kind: "structured-config",
      path: relativePath,
      exists: true,
      parsed: null,
      parseError: `not read: ${printable(refusal)}`,
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
    const instructionDirectory = await resolveRepoDirectory(
      cwd,
      SCOPED_COPILOT_INSTRUCTION_DIRECTORY,
    );
    if (instructionDirectory === null) {
      return [];
    }
    entries = await readdir(instructionDirectory);
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

  if ((await readRepoFile(cwd, ROOT_COPILOT_INSTRUCTION_FILE)).exists) {
    instructions.push({
      kind: "copilot-instruction",
      path: ROOT_COPILOT_INSTRUCTION_FILE,
      exists: true,
    });
  }

  instructions.push(...(await discoverScopedCopilotInstructions(cwd)));
  return instructions;
}

interface IsolationCheck {
  status: IsolationStatus;
  gitCheckError: string | null;
}

async function checkIsolation(cwd: string): Promise<IsolationCheck> {
  const { exists, contents } = await readRepoFile(cwd, ".gitignore");
  if (!exists) {
    return { status: "no-gitignore-file", gitCheckError: null };
  }
  if (contents === null || !gitignoreListsAgemonState(contents)) {
    return { status: "not-ignored", gitCheckError: null };
  }
  const verdict = await gitIgnoresAgemonState(cwd);
  if (verdict.kind === "failed") {
    return {
      status: "not-ignored",
      gitCheckError: `could not ask git whether .agemon/ is ignored: ${describeGitFailure(verdict.detail)}`,
    };
  }
  return {
    status:
      verdict.kind === "ignored" || verdict.kind === "not-a-repository"
        ? "ignored"
        : "not-ignored",
    gitCheckError: null,
  };
}

export async function readIsolationStatus(
  cwd: string,
): Promise<IsolationStatus> {
  return (await checkIsolation(cwd)).status;
}

interface TrackedAgemonPaths {
  trackedAgemonPaths: string[];
  trackingCheckError: string | null;
}

function describeGitFailure(text: string): string {
  const lastLine = text.trim().split(/\r?\n/).at(-1) ?? "";
  return printable(lastLine).slice(0, GIT_ERROR_MAX_CHARACTERS);
}

async function listTrackedAgemonPaths(
  cwd: string,
): Promise<TrackedAgemonPaths> {
  const result = await runRepositoryGit(cwd, ["ls-files", "--", ".agemon"]);
  const failure =
    result.code !== 0
      ? describeGitFailure(result.stderr || "git failed")
      : result.stdout.endsWith(TRUNCATION_MARKER)
        ? "git ls-files output exceeded the capture limit"
        : null;
  if (failure !== null) {
    return {
      trackedAgemonPaths: [],
      trackingCheckError: (await hasGitEntry(cwd))
        ? `could not check whether .agemon/ is tracked by git: ${failure}`
        : null,
    };
  }
  return {
    trackedAgemonPaths: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    trackingCheckError: null,
  };
}

function joinGitCheckErrors(...errors: Array<string | null>): string | null {
  const reported = errors.filter((error): error is string => error !== null);
  return reported.length === 0 ? null : reported.join("; ");
}

export async function discoverRepository(
  ctx: Context,
): Promise<DiscoveryResult> {
  const ruleFiles = await Promise.all(
    ROOT_RULE_FILES.map(async (relativePath) => {
      const { exists, contents } = await readRepoFile(ctx.cwd, relativePath);
      return {
        kind: "rule-file" as const,
        path: relativePath,
        exists,
        contents,
      };
    }),
  );

  const structuredConfigs = await Promise.all(
    STRUCTURED_CONFIG_FILES.map((relativePath) =>
      discoverStructuredConfig(ctx.cwd, relativePath),
    ),
  );

  const isolationCheck = await checkIsolation(ctx.cwd);
  const tracked = await listTrackedAgemonPaths(ctx.cwd);
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
      status: isolationCheck.status,
      trackedAgemonPaths: tracked.trackedAgemonPaths,
      trackingCheckError: joinGitCheckErrors(
        isolationCheck.gitCheckError,
        tracked.trackingCheckError,
      ),
    },
  };
}
