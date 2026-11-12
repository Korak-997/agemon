import { execFile, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  agentFileStem,
  renderAgentFile,
} from "../../src/plugins/agents/index.js";
import {
  DELEGATION_GUARD_SCRIPT_PATH,
  readBundledDelegationGuardScript,
  settingsWithDelegationGuardHooks,
} from "../../src/plugins/delegation-guard/index.js";
import { renderRuleFileContents } from "../../src/plugins/master-prompt/index.js";
import {
  CORE_AGENTS,
  findSkillGroup,
} from "../../src/plugins/skills/catalog.js";
import {
  assessRunIn,
  type ClaudeRunner,
  currentCommit,
  finalResultText,
  reportedModel,
  runScratchDirectory,
  runUsage,
  spawnClaude,
  transcriptEvents,
} from "../design-eval/claude.js";
import { generateLargeBase } from "./large-base.js";
import {
  bootstrapDifference,
  type CostDifference,
  costPerSolvedTask,
} from "./stats.js";

export type RoutingArm = "N" | "A" | "C" | "G";
type RetiredArm = "R" | "RD";
export type RecordedArm = RoutingArm | RetiredArm;
type SessionModel = "opus" | "sonnet";
type TaskBase = "small" | "large";

export type Grader =
  | { kind: "answer"; answer: string }
  | { kind: "tests" }
  | { kind: "review"; file: string; lines: readonly number[] };

export interface RoutingTask {
  name: string;
  prompt: string;
  base: TaskBase;
  grader: Grader;
}

export interface RoutingRun {
  task: string;
  arm: RecordedArm;
  repeat: number;
  passed: boolean;
  failure?: string;
  turns: number;
  costUsd: number;
  costIsCapEstimate?: boolean;
  costByModel: Record<string, number>;
  agentCalls: number;
  agentCallsWithModel: number;
  agentCallsToRoleAgents: number;
  // Absent from runs recorded before Phase 3.
  agentCallsByModel?: Record<string, number>;
}

export interface ArmSummary {
  runs: number;
  passed: number;
  costUsd: number;
  costPerSolvedTask: number;
  turns: number;
  costByModel: Record<string, number>;
  agentCalls: number;
  agentCallsByModel: Record<string, number>;
  shareNamingModel: number | null;
  shareToRoleAgents: number | null;
  mostExpensiveTaskShare: number;
  costPerSolvedTaskDifference: CostDifference | null;
  passes: boolean | null;
}

type ArmSummaries = Partial<Record<RecordedArm, ArmSummary>>;

interface RoutingResults {
  label: string;
  confidence: string;
  arms?: RecordedArm[];
  sessionModel: string;
  effort: string;
  cliVersion: string;
  agemonCommit: string;
  maxBudgetUsd: number;
  isolationNote: string;
  summary: ArmSummaries;
  runs: RoutingRun[];
}

const ROUTING_ARMS: readonly RoutingArm[] = ["N", "A", "C", "G"];
const ARMS_BEFORE_PHASE_3: readonly RecordedArm[] = ["N", "R", "RD"];
const DEFAULT_ARMS = "N,A";
const SESSION_MODELS: readonly SessionModel[] = ["opus", "sonnet"];
const DEFAULT_SESSION_MODEL: SessionModel = "opus";
const PENDING_ARM_INSTALLERS: Partial<Record<RoutingArm, string>> = {
  C: "arm C needs Phase 4",
};
export const LARGE_BASE_SEED = 20261111;
const ROUTING_ROOT = resolve(import.meta.dirname, "../../evals/routing");
const BASE_DIRECTORY = join(ROUTING_ROOT, "base");
const TASKS_DIRECTORY = join(ROUTING_ROOT, "tasks");
const RESULTS_DIRECTORY = join(ROUTING_ROOT, "results");
const WORKFLOW_GROUP = "workflow";
const AGENT_RULES_FILE = "AGENTS.md";
const POINTER_FILE = "CLAUDE.md";
const SUBAGENT_RULES_SECTION = /## Subagent Models\n[\s\S]*?\n(?=## )/u;
const SUBAGENT_DEFAULT_MODEL = "sonnet";
// Headless runs cannot answer the guard's per-chat question, so arm G turns it on up front.
const GUARD_TURNED_ON = { AGEMON_GUARD: "on" };
const WORKFLOW_ROLE_AGENTS = findSkillGroup(WORKFLOW_GROUP)?.agents ?? [];
const ROLE_AGENT_NAMES = WORKFLOW_ROLE_AGENTS.map((agent) => agent.name);
const ROUTING_TOOLS = "Agent,Read,Glob,Grep,Write,Edit,Bash";
const TEST_COMMAND_RULES = ["Bash(npm test:*)", "Bash(node --test:*)"];
const MAX_TURNS = 60;
const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_REPEATS = 4;
const DEFAULT_BATCH_SIZE = 3;
const GRADER_TEST_TIMEOUT_MS = 60_000;
const ALLOWED_FEWER_PASSING_RUNS_PER_TASK = 1;
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 1;
const ANSWER_TOKEN_PATTERN = /[\w./-]+\.(?:js|log)#[\w-]+/gu;
const INDICATIVE_NOTE =
  "Indicative: a few runs per task can catch only large effects, and a null result means no large effect.";
const ISOLATION_NOTE =
  "Runs use only project and local settings, with no MCP servers or web tools. Account-synced skills stay listed, but the Skill tool is off.";

export function loadTasks(names?: string[]): RoutingTask[] {
  const available = readdirSync(TASKS_DIRECTORY).sort();
  for (const name of names ?? []) {
    if (!available.includes(name)) {
      throw new Error(
        `unknown task ${JSON.stringify(name)}; choose from: ${available.join(", ")}`,
      );
    }
  }
  return (names ?? available).map((name) => {
    const { base = "small", ...grader } = JSON.parse(
      readFileSync(join(TASKS_DIRECTORY, name, "task.json"), "utf8"),
    );
    return {
      name,
      prompt: readFileSync(join(TASKS_DIRECTORY, name, "prompt.md"), "utf8"),
      base,
      grader,
    };
  });
}

function overlayOf(task: RoutingTask): string {
  return join(TASKS_DIRECTORY, task.name, "overlay");
}

export async function prepareProject(
  projectDirectory: string,
  task: RoutingTask,
): Promise<void> {
  if (task.base === "large") {
    await generateLargeBase(projectDirectory, LARGE_BASE_SEED);
  } else {
    cpSync(BASE_DIRECTORY, projectDirectory, { recursive: true });
  }
  if (existsSync(overlayOf(task))) {
    cpSync(overlayOf(task), projectDirectory, { recursive: true });
  }
}

export async function installRouting(
  projectDirectory: string,
  arm: RoutingArm,
): Promise<void> {
  const pendingInstaller = PENDING_ARM_INSTALLERS[arm];
  if (pendingInstaller) throw new Error(pendingInstaller);
  const fullRules = renderRuleFileContents(AGENT_RULES_FILE, null);
  writeFileSync(
    join(projectDirectory, AGENT_RULES_FILE),
    arm === "N" ? fullRules.replace(SUBAGENT_RULES_SECTION, "") : fullRules,
  );
  writeFileSync(
    join(projectDirectory, POINTER_FILE),
    renderRuleFileContents(POINTER_FILE, null),
  );
  if (arm === "N") return;
  const agentsDirectory = join(projectDirectory, ".claude", "agents");
  mkdirSync(agentsDirectory, { recursive: true });
  for (const agent of [...CORE_AGENTS, ...WORKFLOW_ROLE_AGENTS]) {
    writeFileSync(
      join(agentsDirectory, `${agentFileStem(agent)}.md`),
      await renderAgentFile(agent),
    );
  }
  const env = {
    CLAUDE_CODE_SUBAGENT_MODEL: SUBAGENT_DEFAULT_MODEL,
    ...(arm === "G" ? GUARD_TURNED_ON : {}),
  };
  const settings = `${JSON.stringify({ env }, null, 2)}\n`;
  writeFileSync(
    join(projectDirectory, ".claude", "settings.json"),
    arm === "G" ? settingsWithDelegationGuardHooks(settings) : settings,
  );
  if (arm === "G") {
    mkdirSync(join(projectDirectory, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(projectDirectory, DELEGATION_GUARD_SCRIPT_PATH),
      await readBundledDelegationGuardScript(),
    );
  }
}

export function totalTurns(transcript: string): number {
  return transcriptEvents(transcript)
    .filter((event) => event.type === "result")
    .reduce((sum, event) => sum + Number(event.num_turns ?? 0), 0);
}

function lastResultEvent(
  transcript: string,
): Record<string, unknown> | undefined {
  return transcriptEvents(transcript)
    .filter((event) => event.type === "result")
    .at(-1);
}

export function costByModel(transcript: string): Record<string, number> {
  const usage = (lastResultEvent(transcript)?.modelUsage ?? {}) as Record<
    string,
    { costUSD: number }
  >;
  return Object.fromEntries(
    Object.entries(usage).map(([model, { costUSD }]) => [model, costUSD]),
  );
}

export function agentCallCounts(
  transcript: string,
): Required<
  Pick<
    RoutingRun,
    | "agentCalls"
    | "agentCallsWithModel"
    | "agentCallsToRoleAgents"
    | "agentCallsByModel"
  >
> {
  const events = transcriptEvents(transcript);
  const inputs = events.flatMap((event) => {
    const content = (event.message as { content?: unknown } | undefined)
      ?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) return [];
    return content
      .filter((block) => block.type === "tool_use" && block.name === "Agent")
      .map((block) => block.input as Record<string, unknown>);
  });
  const modelBySubagent = new Map<string, string>();
  const agentCallsByModel: Record<string, number> = {};
  for (const event of events) {
    const subagent = event.parent_tool_use_id;
    const model = (event.message as { model?: unknown } | undefined)?.model;
    if (
      event.type === "assistant" &&
      typeof subagent === "string" &&
      typeof model === "string" &&
      !modelBySubagent.has(subagent)
    ) {
      modelBySubagent.set(subagent, model);
      agentCallsByModel[model] = (agentCallsByModel[model] ?? 0) + 1;
    }
  }
  return {
    agentCalls: inputs.length,
    agentCallsWithModel: inputs.filter((input) => input.model).length,
    agentCallsToRoleAgents: inputs.filter((input) =>
      ROLE_AGENT_NAMES.includes(String(input.subagent_type)),
    ).length,
    agentCallsByModel,
  };
}

function visibleRoleAgents(transcript: string): string[] {
  const init = transcriptEvents(transcript).find(
    (event) => event.type === "system" && event.subtype === "init",
  );
  const agents = Array.isArray(init?.agents) ? (init.agents as string[]) : [];
  return agents.filter((agent) => ROLE_AGENT_NAMES.includes(agent));
}

export function gradeAnswer(reply: string, answer: string): boolean {
  const tokens = new Set(reply.match(ANSWER_TOKEN_PATTERN));
  return tokens.size === 1 && tokens.has(answer);
}

export function gradeReview(
  reply: string,
  grader: Extract<Grader, { kind: "review" }>,
): boolean {
  const escapedFile = basename(grader.file).replace(/\./gu, "\\.");
  const named = reply.matchAll(new RegExp(`${escapedFile}:(\\d+)`, "gu"));
  return [...named].some((match) => grader.lines.includes(Number(match[1])));
}

export async function gradeTests(
  projectDirectory: string,
  task: RoutingTask,
): Promise<boolean> {
  const projectTests = join(projectDirectory, "test");
  rmSync(projectTests, { recursive: true, force: true });
  cpSync(join(BASE_DIRECTORY, "test"), projectTests, { recursive: true });
  const overlayTests = join(overlayOf(task), "test");
  if (existsSync(overlayTests)) {
    cpSync(overlayTests, projectTests, { recursive: true });
  }
  try {
    await promisify(execFile)("node", ["--test"], {
      cwd: projectDirectory,
      timeout: GRADER_TEST_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function grade(
  task: RoutingTask,
  projectDirectory: string,
  transcript: string,
): Promise<boolean> {
  const { grader } = task;
  const reply = finalResultText(transcript);
  if (grader.kind === "answer") return gradeAnswer(reply, grader.answer);
  if (grader.kind === "review") return gradeReview(reply, grader);
  return gradeTests(projectDirectory, task);
}

interface CellOptions {
  task: RoutingTask;
  arm: RoutingArm;
  repeat: number;
  runner: ClaudeRunner;
  workRoot: string;
  transcriptDirectory: string;
  maxBudgetUsd: number;
  model?: string;
  effort?: string;
}

export async function runCell(
  options: CellOptions,
): Promise<{ run?: RoutingRun; abort?: string; sessionModel?: string }> {
  const { task, arm, repeat, maxBudgetUsd } = options;
  mkdirSync(options.transcriptDirectory, { recursive: true });
  const projectDirectory = mkdtempSync(
    join(options.workRoot, `${task.name}-${arm}-`),
  );
  await prepareProject(projectDirectory, task);
  await installRouting(projectDirectory, arm);
  const claudeRun = await options.runner({
    cwd: projectDirectory,
    prompt: task.prompt,
    maxTurns: MAX_TURNS,
    permissionMode: "acceptEdits",
    tools: ROUTING_TOOLS,
    allowedTools: TEST_COMMAND_RULES,
    model: options.model,
    effort: options.effort,
    maxBudgetUsd,
  });
  writeFileSync(
    join(options.transcriptDirectory, `${task.name}-${arm}-r${repeat}.jsonl`),
    claudeRun.transcript,
    { flag: "wx" },
  );
  const assessment = assessRunIn(claudeRun, projectDirectory);
  const leakedRoleAgents =
    arm === "N" ? visibleRoleAgents(claudeRun.transcript) : [];
  const passed =
    assessment.status === "ok" &&
    (await grade(task, projectDirectory, claudeRun.transcript));
  rmSync(projectDirectory, { recursive: true, force: true });
  rmSync(runScratchDirectory(projectDirectory), {
    recursive: true,
    force: true,
  });
  if (leakedRoleAgents.length > 0) {
    return { abort: `arm N can see ${leakedRoleAgents.join(", ")}` };
  }
  if (assessment.status === "fatal" || assessment.abortsBatch) {
    return { abort: assessment.reason };
  }
  const usage = runUsage(claudeRun.transcript);
  return {
    sessionModel: reportedModel(claudeRun.transcript),
    run: {
      task: task.name,
      arm,
      repeat,
      passed,
      failure: assessment.reason,
      turns: totalTurns(claudeRun.transcript),
      costUsd: usage.costUsd ?? maxBudgetUsd,
      costIsCapEstimate: usage.costUsd === undefined ? true : undefined,
      costByModel: costByModel(claudeRun.transcript),
      ...agentCallCounts(claudeRun.transcript),
    },
  };
}

function sumByKey(
  records: readonly Record<string, number>[],
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      sums[key] = (sums[key] ?? 0) + value;
    }
  }
  return sums;
}

function summarizeArm(runs: RoutingRun[]): ArmSummary {
  const total = (pick: (run: RoutingRun) => number) =>
    runs.reduce((sum, run) => sum + pick(run), 0);
  const agentCalls = total((run) => run.agentCalls);
  const shareOfAgentCalls = (count: number) =>
    agentCalls === 0 ? null : count / agentCalls;
  const costUsd = total((run) => run.costUsd);
  const costByTask = sumByKey(runs.map((run) => ({ [run.task]: run.costUsd })));
  return {
    runs: runs.length,
    passed: runs.filter((run) => run.passed).length,
    costUsd,
    costPerSolvedTask: costPerSolvedTask(runs),
    turns: total((run) => run.turns),
    costByModel: sumByKey(runs.map((run) => run.costByModel)),
    agentCalls,
    agentCallsByModel: sumByKey(runs.map((run) => run.agentCallsByModel ?? {})),
    shareNamingModel: shareOfAgentCalls(
      total((run) => run.agentCallsWithModel),
    ),
    shareToRoleAgents: shareOfAgentCalls(
      total((run) => run.agentCallsToRoleAgents),
    ),
    mostExpensiveTaskShare: Math.max(...Object.values(costByTask)) / costUsd,
    costPerSolvedTaskDifference: null,
    passes: null,
  };
}

function keepsPassCountOnEveryTask(
  baseline: readonly RoutingRun[],
  candidate: readonly RoutingRun[],
): boolean {
  const passedOn = (runs: readonly RoutingRun[], task: string) =>
    runs.filter((run) => run.task === task && run.passed).length;
  return [...new Set(baseline.map((run) => run.task))].every(
    (task) =>
      passedOn(candidate, task) >=
      passedOn(baseline, task) - ALLOWED_FEWER_PASSING_RUNS_PER_TASK,
  );
}

export function applyPassRule(
  runs: RoutingRun[],
  baselineArm: RecordedArm,
): ArmSummaries {
  const summary: ArmSummaries = {};
  const runsOf = (arm: RecordedArm) => runs.filter((run) => run.arm === arm);
  for (const arm of new Set(runs.map((run) => run.arm))) {
    summary[arm] = summarizeArm(runsOf(arm));
  }
  const baselineRuns = runsOf(baselineArm);
  if (baselineRuns.length === 0) return summary;
  for (const [arm, armSummary] of Object.entries(summary)) {
    const candidateRuns = runsOf(arm as RecordedArm);
    if (arm === baselineArm || candidateRuns.length !== baselineRuns.length) {
      continue;
    }
    armSummary.costPerSolvedTaskDifference = bootstrapDifference(
      baselineRuns,
      candidateRuns,
      BOOTSTRAP_RESAMPLES,
      BOOTSTRAP_SEED,
    );
    armSummary.passes =
      keepsPassCountOnEveryTask(baselineRuns, candidateRuns) &&
      armSummary.costPerSolvedTaskDifference.high < 0;
  }
  return summary;
}

export function plannedCells(
  taskNames: string[],
  arms: readonly RoutingArm[],
  repeats: number,
): { task: string; arm: RoutingArm; repeat: number }[] {
  const cells = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const [taskIndex, task] of taskNames.entries()) {
      for (let offset = 0; offset < arms.length; offset += 1) {
        const arm = arms[(taskIndex + repeat + offset) % arms.length];
        cells.push({ task, arm, repeat });
      }
    }
  }
  return cells;
}

function parseArms(value: string): RoutingArm[] {
  const arms = value.split(",");
  for (const arm of arms) {
    if (!ROUTING_ARMS.includes(arm as RoutingArm)) {
      throw new Error(
        `unknown arm ${JSON.stringify(arm)}; choose from: ${ROUTING_ARMS.join(", ")}`,
      );
    }
  }
  return arms as RoutingArm[];
}

function parseSessionModel(value: string): SessionModel {
  if (!SESSION_MODELS.includes(value as SessionModel)) {
    throw new Error(
      `--session-model must be one of: ${SESSION_MODELS.join(", ")}`,
    );
  }
  return value as SessionModel;
}

function assertEnvironmentCannotSkewResults(): void {
  for (const name of ["CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_API_KEY"]) {
    if (process.env[name]) throw new Error(`unset ${name} before running`);
  }
}

function claudeVersion(): string {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}

function resultsFileFor(label: string, now = new Date()): string {
  mkdirSync(RESULTS_DIRECTORY, { recursive: true });
  const suffix = `-${label}.json`;
  const existing = readdirSync(RESULTS_DIRECTORY).find((name) =>
    name.endsWith(suffix),
  );
  const date = now.toISOString().slice(0, 10);
  return join(RESULTS_DIRECTORY, existing ?? `${date}${suffix}`);
}

function saveRoutingResults(path: string, results: RoutingResults): void {
  const [baselineArm] = results.arms ?? ARMS_BEFORE_PHASE_3;
  writeFileSync(
    path,
    `${JSON.stringify(
      { ...results, summary: applyPassRule(results.runs, baselineArm) },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      tasks: { type: "string" },
      arms: { type: "string", default: DEFAULT_ARMS },
      "session-model": { type: "string", default: DEFAULT_SESSION_MODEL },
      repeats: { type: "string", default: String(DEFAULT_REPEATS) },
      limit: { type: "string", default: String(DEFAULT_BATCH_SIZE) },
      effort: { type: "string" },
      "max-budget-usd": {
        type: "string",
        default: String(DEFAULT_MAX_BUDGET_USD),
      },
    },
  });
  if (!values.label) throw new Error("--label is required");
  assertEnvironmentCannotSkewResults();
  const maxBudgetUsd = Number(values["max-budget-usd"]);
  if (!(maxBudgetUsd > 0)) throw new Error("--max-budget-usd must be positive");
  const arms = parseArms(values.arms);
  const sessionModel = parseSessionModel(values["session-model"]);
  const tasks = loadTasks(values.tasks?.split(","));
  const resultsFile = resultsFileFor(values.label);
  const cliVersion = claudeVersion();
  const results: RoutingResults = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, "utf8"))
    : {
        label: values.label,
        confidence: INDICATIVE_NOTE,
        arms,
        sessionModel,
        effort: values.effort ?? "default",
        cliVersion,
        agemonCommit: currentCommit(),
        maxBudgetUsd,
        isolationNote: ISOLATION_NOTE,
        summary: {},
        runs: [],
      };
  if (results.cliVersion !== cliVersion) {
    throw new Error(
      `${basename(resultsFile)} used ${results.cliVersion}, this is ${cliVersion}`,
    );
  }
  const recordedArms = (results.arms ?? ARMS_BEFORE_PHASE_3).join(",");
  if (recordedArms !== arms.join(",")) {
    throw new Error(
      `${basename(resultsFile)} compares arms ${recordedArms}, not ${arms.join(",")}`,
    );
  }
  const isDone = (cell: { task: string; arm: RoutingArm; repeat: number }) =>
    results.runs.some(
      (run) =>
        run.task === cell.task &&
        run.arm === cell.arm &&
        run.repeat === cell.repeat,
    );
  const planned = plannedCells(
    tasks.map((task) => task.name),
    arms,
    Number(values.repeats),
  );
  const batch = planned
    .filter((cell) => !isDone(cell))
    .slice(0, Number(values.limit));
  const workRoot = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "routing-eval-"),
  );
  for (const cell of batch) {
    const outcome = await runCell({
      ...cell,
      task: tasks.find((task) => task.name === cell.task) as RoutingTask,
      runner: spawnClaude,
      workRoot,
      transcriptDirectory: join(
        resultsFile.replace(/\.json$/u, ""),
        "transcripts",
      ),
      maxBudgetUsd,
      model: sessionModel,
      effort: values.effort,
    });
    if (!outcome.run) {
      saveRoutingResults(resultsFile, results);
      rmSync(workRoot, { recursive: true, force: true });
      throw new Error(`batch stopped: ${outcome.abort}`);
    }
    results.sessionModel = outcome.sessionModel ?? results.sessionModel;
    results.runs.push(outcome.run);
    saveRoutingResults(resultsFile, results);
    const { task, arm, repeat, passed, costUsd, turns, agentCalls } =
      outcome.run;
    console.log(
      `${task} ${arm} r${repeat}: ${passed ? "pass" : "FAIL"} $${costUsd.toFixed(2)} ${turns} turns ${agentCalls} agents ${outcome.run.failure ?? ""}`,
    );
  }
  rmSync(workRoot, { recursive: true, force: true });
  const spent = results.runs.reduce((sum, run) => sum + run.costUsd, 0);
  console.log(
    `${results.runs.length}/${planned.length} runs recorded, $${spent.toFixed(2)} in total: ${resultsFile}`,
  );
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
