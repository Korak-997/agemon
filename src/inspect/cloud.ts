import { hasGitEntry } from "../core/repo-paths.js";
import { runRepositoryGit } from "../core/repository-git.js";
import { TRUNCATION_MARKER } from "../core/subprocess-runner.js";
import { CODE_REVIEW_GRAPH_PACKAGE_SPEC } from "../plugins/pins.js";

export const CONFIG_READ_FROM_THE_CLONE: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
  ".claude/commands",
  ".claude/settings.json",
  ".mcp.json",
  ".agents/skills",
];

const CODE_REVIEW_GRAPH_COMMAND = "code-review-graph";
const RUN_DIRECTLY_BY_A_COMMAND = new RegExp(
  `(?:^|[;&|(\\n]\\s*)${CODE_REVIEW_GRAPH_COMMAND}(?![\\w-])`,
  "u",
);

const CLOUD_SETUP_SCRIPT = `#!/bin/bash
UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install ${CODE_REVIEW_GRAPH_PACKAGE_SPEC}
`;

const STATUS_FIELD_SEPARATOR = "\0";
const STATUS_CODE_LENGTH = 2;
const STATUS_PATH_OFFSET = STATUS_CODE_LENGTH + 1;
const IGNORED_STATUS = "!!";
const RENAME_OR_COPY_STATUS = /^[RC]/u;

export interface CloudReadiness {
  uncommittedPaths: string[];
  ignoredPaths: string[];
  unpushedCommits: number | null;
  gitCheckError: string | null;
  toolsToInstall: string[];
  setupScript: string | null;
}

function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(commandsIn);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "command" && typeof entry === "string"
      ? [entry]
      : commandsIn(entry),
  );
}

export function findToolsCloudSessionsNeed(
  parsedConfigs: readonly unknown[],
): string[] {
  return commandsIn([...parsedConfigs]).some((command) =>
    RUN_DIRECTLY_BY_A_COMMAND.test(command),
  )
    ? [CODE_REVIEW_GRAPH_COMMAND]
    : [];
}

interface WorkingTreeStatus {
  uncommittedPaths: string[];
  ignoredPaths: string[];
}

function parseStatus(output: string): WorkingTreeStatus {
  const status: WorkingTreeStatus = { uncommittedPaths: [], ignoredPaths: [] };
  const fields = output.split(STATUS_FIELD_SEPARATOR).filter(Boolean);
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index].slice(0, STATUS_CODE_LENGTH);
    const path = fields[index].slice(STATUS_PATH_OFFSET);
    (code === IGNORED_STATUS
      ? status.ignoredPaths
      : status.uncommittedPaths
    ).push(path);
    if (RENAME_OR_COPY_STATUS.test(code)) {
      index += 1;
    }
  }
  return status;
}

async function countUnpushedCommits(cwd: string): Promise<number | null> {
  const result = await runRepositoryGit(cwd, [
    "rev-list",
    "--count",
    "@{upstream}..HEAD",
    "--",
    ...CONFIG_READ_FROM_THE_CLONE,
  ]);
  return result.code === 0 ? Number(result.stdout.trim()) : null;
}

export async function checkCloudReadiness(
  cwd: string,
  parsedConfigs: readonly unknown[],
): Promise<CloudReadiness> {
  const toolsToInstall = findToolsCloudSessionsNeed(parsedConfigs);
  const setupScript = toolsToInstall.length > 0 ? CLOUD_SETUP_SCRIPT : null;
  const result = await runRepositoryGit(cwd, [
    "status",
    "--porcelain",
    "-z",
    "--ignored",
    "--untracked-files=normal",
    "--",
    ...CONFIG_READ_FROM_THE_CLONE,
  ]);
  if (result.code !== 0 || result.stdout.endsWith(TRUNCATION_MARKER)) {
    return {
      uncommittedPaths: [],
      ignoredPaths: [],
      unpushedCommits: null,
      gitCheckError: (await hasGitEntry(cwd))
        ? "could not ask git which agent config is committed"
        : "not a git repository, so Claude Code on the web can't clone it",
      toolsToInstall,
      setupScript,
    };
  }
  return {
    ...parseStatus(result.stdout),
    unpushedCommits: await countUnpushedCommits(cwd),
    gitCheckError: null,
    toolsToInstall,
    setupScript,
  };
}
