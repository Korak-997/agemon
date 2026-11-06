import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Arm = "A" | "B" | "C";

export interface ClaudeRequest {
  cwd: string;
  prompt: string;
  maxTurns: number;
  permissionMode: "plan" | "acceptEdits";
  tools: string;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
}

export interface ClaudeRun {
  transcript: string;
  exitCode: number | null;
  failure?: "timeout" | "buffer-overflow";
  stderr?: string;
}

export type ClaudeRunner = (request: ClaudeRequest) => Promise<ClaudeRun>;

export interface EvalResults<Case> {
  model: string;
  effort: string;
  agemonCommit: string;
  arm: Arm;
  skillRef: string;
  isolationNote: string;
  totalCostUsd?: number;
  totalTurns?: number;
  contaminated?: boolean;
  aborted?: string;
  cases: Case[];
}

export interface RunAssessment {
  status: "ok" | "errored" | "fatal";
  reason?: string;
  abortsBatch?: boolean;
}

export interface RunUsage {
  costUsd?: number;
  numTurns?: number;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
export const EVAL_ROOT = join(REPOSITORY_ROOT, "evals", "design");
export const DEFAULT_SKILL_REF = "c056fdc41d9eef734b85239bb21b5560e081cb3c";
export const WORKING_TREE_REF = "WORKTREE";
export const PROJECT_DESIGN_SKILL = "agemon-design";
export const DESIGN_SKILL_PATTERN = /(^|:)agemon-design(-\w+)?$/u;
export const ACTIVATION_TOOLS = "Skill,Read,Glob,Grep";
export const BUILD_TOOLS = "Skill,Read,Glob,Grep,Write,Edit";
export const DIRECTION_BUILD_TOOLS = `${BUILD_TOOLS},Bash`;
const SHELL_TOOL = "Bash";
const ALWAYS_UNAVAILABLE_TOOLS =
  "WebFetch,WebSearch,Artifact,ToolSearch,NotebookEdit";
const SKILL_SCRIPTS_FOLDER = ".claude/skills/agemon-design/scripts";
const SKILL_SCRIPTS = ["inventory.mjs", "deal.mjs", "check-source.mjs"];
const FILE_WRITING_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);
export const ISOLATION_NOTE =
  "Runs use only project and local settings, but account-synced skills stay listed (other agemon-* skills included); only agemon-design* names are checked.";
const SKILLS_ROOT = "assets/skills";
const DESIGN_GROUP = "design";
const ESSENTIALS_GROUP = "essentials";
const ESSENTIALS_FALLBACK_DIRECTORY = join(
  REPOSITORY_ROOT,
  "test",
  "fixtures",
  "essentials-pinned-063bee94",
);
const COMPANION_GROUPS = [
  "architecture",
  "code-quality",
  "commit",
  ESSENTIALS_GROUP,
  "performance",
  "security",
];
const RUN_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIPT_BUFFER_BYTES = 256 * 1024 * 1024;
const MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
const MAX_TURNS_SUBTYPE = "error_max_turns";
const LIMIT_OR_AUTH_PATTERN =
  /usage limit|rate.?limit|limit reached|out of (extra )?usage|credit balance|not logged in|\/login|authentication|invalid (api key|credentials)|unauthorized|\b401\b/iu;
const SAFE_MODEL_PATTERN = /^[a-z0-9][\w.[\]-]*$/iu;

export function parseArm(value: string | undefined): Arm {
  if (value === "A" || value === "B" || value === "C") return value;
  throw new Error(`--arm must be A, B or C, got ${JSON.stringify(value)}`);
}

// Arm B is the old skill by definition. Arm C must name the commit it tests, so a results file
// can never claim the pipeline while silently holding the old skill.
export function skillRefFor(arm: Arm, requested: string | undefined): string {
  if (requested) return requested;
  if (arm === "C") throw new Error("arm C needs --skill-ref <commit>");
  return DEFAULT_SKILL_REF;
}

// The selector cannot run without a shell, so arm C gets one limited to the skill's own read-only
// scripts and its log-writing selector. Every other command stays denied in a headless run.
export function designScriptRules(projectDirectory: string): string[] {
  const folders = [
    SKILL_SCRIPTS_FOLDER,
    join(projectDirectory, SKILL_SCRIPTS_FOLDER),
  ];
  return folders.flatMap((folder) =>
    SKILL_SCRIPTS.map((script) => `${SHELL_TOOL}(node ${folder}/${script}:*)`),
  );
}

export function parseModel(value: string | undefined): string | undefined {
  if (value === undefined || SAFE_MODEL_PATTERN.test(value)) return value;
  throw new Error(`--model looks invalid: ${JSON.stringify(value)}`);
}

export function designSkillNames(names: string[]): string[] {
  return names.filter((name) => DESIGN_SKILL_PATTERN.test(name));
}

function gitBuffer(args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function installSkillGroupFromRef(
  skillsDirectory: string,
  group: string,
  skillRef: string,
): void {
  const groupPath = `${SKILLS_ROOT}/${group}`;
  const files = gitBuffer([
    "ls-tree",
    "-r",
    "--name-only",
    skillRef,
    "--",
    groupPath,
  ])
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  if (files.length === 0 && group === ESSENTIALS_GROUP) {
    cpSync(ESSENTIALS_FALLBACK_DIRECTORY, skillsDirectory, {
      recursive: true,
      filter: (source) =>
        source !== join(ESSENTIALS_FALLBACK_DIRECTORY, "NOTICE.md"),
    });
    return;
  }
  for (const file of files) {
    const target = join(skillsDirectory, file.slice(groupPath.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, gitBuffer(["show", `${skillRef}:${file}`]));
  }
}

export function installArm(
  projectDirectory: string,
  arm: Arm,
  skillRef = DEFAULT_SKILL_REF,
): void {
  if (skillRef.startsWith("-"))
    throw new Error("--skill-ref must be a git ref");
  const groups =
    arm === "A" ? COMPANION_GROUPS : [DESIGN_GROUP, ...COMPANION_GROUPS];
  const skillsDirectory = join(projectDirectory, ".claude", "skills");
  mkdirSync(skillsDirectory, { recursive: true });
  for (const group of groups) {
    if (skillRef === WORKING_TREE_REF) {
      cpSync(join(REPOSITORY_ROOT, SKILLS_ROOT, group), skillsDirectory, {
        recursive: true,
      });
    } else {
      installSkillGroupFromRef(skillsDirectory, group, skillRef);
    }
  }
}

export function buildClaudeArgv(request: ClaudeRequest): string[] {
  const argv = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns",
    String(request.maxTurns),
    "--permission-mode",
    request.permissionMode,
    "--tools",
    request.tools,
    "--disallowed-tools",
    request.tools.split(",").includes(SHELL_TOOL)
      ? ALWAYS_UNAVAILABLE_TOOLS
      : `${SHELL_TOOL},${ALWAYS_UNAVAILABLE_TOOLS}`,
  ];
  if (request.allowedTools) {
    argv.push("--allowedTools", request.allowedTools.join(","));
  }
  if (request.model) argv.push("--model", request.model);
  if (request.effort) argv.push("--effort", request.effort);
  if (request.maxBudgetUsd) {
    argv.push("--max-budget-usd", String(request.maxBudgetUsd));
  }
  return argv;
}

export function spawnClaude(request: ClaudeRequest): Promise<ClaudeRun> {
  const argv = buildClaudeArgv(request);
  return new Promise((resolveRun) => {
    execFile(
      "claude",
      argv,
      {
        cwd: request.cwd,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: TRANSCRIPT_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? typeof error.code === "number"
            ? error.code
            : null
          : 0;
        const failure =
          error?.code === MAX_BUFFER_ERROR_CODE
            ? "buffer-overflow"
            : error?.killed
              ? "timeout"
              : undefined;
        resolveRun({ transcript: stdout, exitCode, failure, stderr });
      },
    );
  });
}

function transcriptEvents(transcript: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of transcript.split("\n")) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {}
  }
  return events;
}

function initEvent(transcript: string): Record<string, unknown> | undefined {
  return transcriptEvents(transcript).find(
    (event) => event.type === "system" && event.subtype === "init",
  );
}

export function activatedSkills(transcript: string): string[] {
  const skills: string[] = [];
  for (const event of transcriptEvents(transcript)) {
    const content = (event.message as { content?: unknown } | undefined)
      ?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Skill") {
        skills.push(String(block.input?.skill));
      }
    }
  }
  return skills;
}

export function announcedSkills(transcript: string): string[] {
  const skills = initEvent(transcript)?.skills;
  return Array.isArray(skills) ? (skills as string[]) : [];
}

export function reportedModel(transcript: string): string | undefined {
  const model = initEvent(transcript)?.model;
  return typeof model === "string" ? model : undefined;
}

export function assessRun(run: ClaudeRun): RunAssessment {
  if (run.failure) return { status: "errored", reason: run.failure };
  if (run.transcript.trim() === "") {
    return fatalOrErrored(run.stderr ?? "", "empty-transcript");
  }
  const result = transcriptEvents(run.transcript)
    .filter((event) => event.type === "result")
    .at(-1);
  if (!result) return fatalOrErrored(run.stderr ?? "", "no-result-event");
  const subtype = String(result.subtype);
  if (subtype === MAX_TURNS_SUBTYPE) return { status: "ok" };
  if (subtype === "success" && result.is_error !== true)
    return { status: "ok" };
  const detail = `${String(result.result ?? "")} ${JSON.stringify(result.errors ?? "")} ${run.stderr ?? ""}`;
  return fatalOrErrored(
    detail,
    result.is_error === true ? `${subtype} with is_error` : subtype,
  );
}

function fatalOrErrored(detail: string, reason: string): RunAssessment {
  return LIMIT_OR_AUTH_PATTERN.test(detail)
    ? { status: "fatal", reason: `usage-limit-or-auth (${reason})` }
    : { status: "errored", reason };
}

export function newBatchId(now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/gu, "").slice(0, 14);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function resultsPath(
  label: string,
  arm: Arm,
  batchId: string,
  suffix?: string,
): string {
  const date = batchId
    .slice(0, 8)
    .replace(/(\d{4})(\d{2})(\d{2})/u, "$1-$2-$3");
  const parts = [date, label, `arm-${arm}`, suffix, batchId].filter(Boolean);
  return join(EVAL_ROOT, "results", `${parts.join("-")}.json`);
}

export function transcriptsDirectory(resultsFile: string): string {
  return join(resultsFile.replace(/\.json$/u, ""), "transcripts");
}

export function redactHome(text: string): string {
  return text.split(homedir()).join("~");
}

export function createResultsFile<Case>(
  path: string,
  results: EvalResults<Case>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`, { flag: "wx" });
}

export function saveResults<Case>(
  path: string,
  results: EvalResults<Case>,
): void {
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

export function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

export function runUsage(transcript: string): RunUsage {
  const result = transcriptEvents(transcript)
    .filter((event) => event.type === "result")
    .at(-1);
  return {
    costUsd:
      typeof result?.total_cost_usd === "number"
        ? result.total_cost_usd
        : undefined,
    numTurns:
      typeof result?.num_turns === "number" ? result.num_turns : undefined,
  };
}

export function sumUsage(runs: RunUsage[]): {
  totalCostUsd: number;
  totalTurns: number;
} {
  return {
    totalCostUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    totalTurns: runs.reduce((sum, run) => sum + (run.numTurns ?? 0), 0),
  };
}

function isPathInside(directory: string, target: string): boolean {
  const relativeTarget = relative(directory, target);
  return relativeTarget.split(sep)[0] !== ".." && !isAbsolute(relativeTarget);
}

// macOS temp directories live under the /var symlink, while Claude Code reports
// the resolved /private/var path for the same files.
function projectDirectoryForms(projectDirectory: string): string[] {
  const lexicalDirectory = resolve(projectDirectory);
  try {
    return [lexicalDirectory, realpathSync(lexicalDirectory)];
  } catch {
    return [lexicalDirectory];
  }
}

// Claude Code gives each session a scratch folder named after the project, outside the project.
// Only this run's own folder is exempt: a write anywhere else still fails the run.
export function runScratchDirectory(projectDirectory: string): string {
  const projectSlug = resolve(projectDirectory).replace(/[^a-zA-Z0-9]/gu, "-");
  return join("/tmp", `claude-${process.getuid?.()}`, projectSlug);
}

export function writtenFilePaths(transcript: string): string[] {
  return transcriptEvents(transcript).flatMap((event) => {
    const content = (event.message as { content?: unknown } | undefined)
      ?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) return [];
    return content
      .filter(
        (block) =>
          block.type === "tool_use" && FILE_WRITING_TOOLS.has(block.name),
      )
      .map((block) => String(block.input?.file_path));
  });
}

export function finalResultText(transcript: string): string {
  const result = transcriptEvents(transcript)
    .filter((event) => event.type === "result")
    .at(-1);
  return String(result?.result ?? "");
}

export function writesOutsideProject(
  transcript: string,
  projectDirectory: string,
): string[] {
  const directoryForms = [
    ...projectDirectoryForms(projectDirectory),
    runScratchDirectory(projectDirectory),
  ];
  const outside: string[] = [];
  for (const event of transcriptEvents(transcript)) {
    const content = (event.message as { content?: unknown } | undefined)
      ?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use" || !FILE_WRITING_TOOLS.has(block.name))
        continue;
      const target = String(
        block.input?.file_path ?? block.input?.notebook_path ?? "",
      );
      const resolvedTarget = resolve(projectDirectory, target);
      if (
        !directoryForms.some((directory) =>
          isPathInside(directory, resolvedTarget),
        )
      ) {
        outside.push(target);
      }
    }
  }
  return outside;
}

export function assessRunIn(
  run: ClaudeRun,
  projectDirectory: string,
): RunAssessment {
  if (writesOutsideProject(run.transcript, projectDirectory).length > 0) {
    return {
      status: "errored",
      reason: "wrote-outside-project",
      abortsBatch: true,
    };
  }
  return assessRun(run);
}
