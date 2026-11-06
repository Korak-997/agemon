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
import { renderAgentFile } from "../../src/plugins/agents/index.js";
import { renderRuleFileContents } from "../../src/plugins/master-prompt/index.js";
import { findSkillGroup } from "../../src/plugins/skills/catalog.js";
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

export type RoutingArm = "N" | "R" | "RD";

export type Grader =
  | { kind: "answer"; answer: string }
  | { kind: "tests" }
  | { kind: "review"; file: string; lines: readonly number[] };

export interface RoutingTask {
  name: string;
  prompt: string;
  grader: Grader;
}

export interface RoutingRun {
  task: string;
  arm: RoutingArm;
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
}

export interface ArmSummary {
  runs: number;
  passed: number;
  costUsd: number;
  turns: number;
  costByModel: Record<string, number>;
  agentCalls: number;
  shareNamingModel: number | null;
  shareToRoleAgents: number | null;
  costChangeAgainstN: number | null;
  passes: boolean | null;
}

interface RoutingResults {
  label: string;
  confidence: string;
  sessionModel: string;
  effort: string;
  cliVersion: string;
  agemonCommit: string;
  maxBudgetUsd: number;
  isolationNote: string;
  summary: Partial<Record<RoutingArm, ArmSummary>>;
  runs: RoutingRun[];
}

const ARMS: readonly RoutingArm[] = ["N", "R", "RD"];
const ROUTING_ROOT = resolve(import.meta.dirname, "../../evals/routing");
const BASE_DIRECTORY = join(ROUTING_ROOT, "base");
const TASKS_DIRECTORY = join(ROUTING_ROOT, "tasks");
const RESULTS_DIRECTORY = join(ROUTING_ROOT, "results");
const WORKFLOW_GROUP = "workflow";
const AGENT_RULES_FILE = "AGENTS.md";
const POINTER_FILE = "CLAUDE.md";
const SUBAGENT_RULES_SECTION = /## Subagent Models\n[\s\S]*?\n(?=## )/u;
const SUBAGENT_DEFAULT_MODEL = "sonnet";
const ROLE_AGENT_NAMES = findSkillGroup(WORKFLOW_GROUP)?.agents?.map(
  (agent) => agent.name,
) as string[];
const SESSION_MODEL = "opus";
const ROUTING_TOOLS = "Agent,Read,Glob,Grep,Write,Edit,Bash";
const TEST_COMMAND_RULES = ["Bash(npm test:*)", "Bash(node --test:*)"];
const MAX_TURNS = 60;
const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_REPEATS = 2;
const DEFAULT_BATCH_SIZE = 3;
const GRADER_TEST_TIMEOUT_MS = 60_000;
const ALLOWED_FEWER_PASSING_RUNS = 1;
const REQUIRED_COST_SAVING = 0.2;
const ANSWER_TOKEN_PATTERN = /[\w./-]+\.js#\w+/gu;
const INDICATIVE_NOTE =
  "Indicative: 12 runs per arm can catch only large effects, and a null result means no large effect.";
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
  return (names ?? available).map((name) => ({
    name,
    prompt: readFileSync(join(TASKS_DIRECTORY, name, "prompt.md"), "utf8"),
    grader: JSON.parse(
      readFileSync(join(TASKS_DIRECTORY, name, "task.json"), "utf8"),
    ),
  }));
}

function overlayOf(task: RoutingTask): string {
  return join(TASKS_DIRECTORY, task.name, "overlay");
}

export function prepareProject(
  projectDirectory: string,
  task: RoutingTask,
): void {
  cpSync(BASE_DIRECTORY, projectDirectory, { recursive: true });
  if (existsSync(overlayOf(task))) {
    cpSync(overlayOf(task), projectDirectory, { recursive: true });
  }
}

export async function installRouting(
  projectDirectory: string,
  arm: RoutingArm,
): Promise<void> {
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
  for (const agent of findSkillGroup(WORKFLOW_GROUP)?.agents ?? []) {
    writeFileSync(
      join(agentsDirectory, `${agent.name}.md`),
      await renderAgentFile(agent),
    );
  }
  if (arm === "RD") {
    writeFileSync(
      join(projectDirectory, ".claude", "settings.json"),
      `${JSON.stringify(
        { env: { CLAUDE_CODE_SUBAGENT_MODEL: SUBAGENT_DEFAULT_MODEL } },
        null,
        2,
      )}\n`,
    );
  }
}

// A session with background subagents emits one result event each time it wakes. Their cost and
// model usage are cumulative, but num_turns restarts, so turns must be added up.
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
): Pick<
  RoutingRun,
  "agentCalls" | "agentCallsWithModel" | "agentCallsToRoleAgents"
> {
  const inputs = transcriptEvents(transcript).flatMap((event) => {
    const content = (event.message as { content?: unknown } | undefined)
      ?.content;
    if (event.type !== "assistant" || !Array.isArray(content)) return [];
    return content
      .filter((block) => block.type === "tool_use" && block.name === "Agent")
      .map((block) => block.input as Record<string, unknown>);
  });
  return {
    agentCalls: inputs.length,
    agentCallsWithModel: inputs.filter((input) => input.model).length,
    agentCallsToRoleAgents: inputs.filter((input) =>
      ROLE_AGENT_NAMES.includes(String(input.subagent_type)),
    ).length,
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
  prepareProject(projectDirectory, task);
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
      // A killed run never emits its result event, so charge the most it could have spent.
      costUsd: usage.costUsd ?? maxBudgetUsd,
      costIsCapEstimate: usage.costUsd === undefined ? true : undefined,
      costByModel: costByModel(claudeRun.transcript),
      ...agentCallCounts(claudeRun.transcript),
    },
  };
}

function summarizeArm(runs: RoutingRun[]): ArmSummary {
  const total = (pick: (run: RoutingRun) => number) =>
    runs.reduce((sum, run) => sum + pick(run), 0);
  const agentCalls = total((run) => run.agentCalls);
  const shareOfAgentCalls = (count: number) =>
    agentCalls === 0 ? null : count / agentCalls;
  const modelCosts: Record<string, number> = {};
  for (const run of runs) {
    for (const [model, cost] of Object.entries(run.costByModel)) {
      modelCosts[model] = (modelCosts[model] ?? 0) + cost;
    }
  }
  return {
    runs: runs.length,
    passed: runs.filter((run) => run.passed).length,
    costUsd: total((run) => run.costUsd),
    turns: total((run) => run.turns),
    costByModel: modelCosts,
    agentCalls,
    shareNamingModel: shareOfAgentCalls(
      total((run) => run.agentCallsWithModel),
    ),
    shareToRoleAgents: shareOfAgentCalls(
      total((run) => run.agentCallsToRoleAgents),
    ),
    costChangeAgainstN: null,
    passes: null,
  };
}

export function applyPassRule(
  runs: RoutingRun[],
): Partial<Record<RoutingArm, ArmSummary>> {
  const summary: Partial<Record<RoutingArm, ArmSummary>> = {};
  for (const arm of ARMS) {
    const armRuns = runs.filter((run) => run.arm === arm);
    if (armRuns.length > 0) summary[arm] = summarizeArm(armRuns);
  }
  const baseline = summary.N;
  if (!baseline) return summary;
  for (const arm of ARMS.filter((name) => name !== "N")) {
    const armSummary = summary[arm];
    if (!armSummary) continue;
    armSummary.costChangeAgainstN = armSummary.costUsd / baseline.costUsd - 1;
    if (armSummary.runs !== baseline.runs) continue;
    armSummary.passes =
      armSummary.passed >= baseline.passed - ALLOWED_FEWER_PASSING_RUNS &&
      armSummary.costUsd <= baseline.costUsd * (1 - REQUIRED_COST_SAVING);
  }
  return summary;
}

// Rotating which arm goes first keeps a time-of-day or rate-limit effect from landing on one arm.
export function plannedCells(
  taskNames: string[],
  repeats: number,
): { task: string; arm: RoutingArm; repeat: number }[] {
  const cells = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const [taskIndex, task] of taskNames.entries()) {
      for (let offset = 0; offset < ARMS.length; offset += 1) {
        const arm = ARMS[(taskIndex + repeat + offset) % ARMS.length];
        cells.push({ task, arm, repeat });
      }
    }
  }
  return cells;
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
  writeFileSync(
    path,
    `${JSON.stringify(
      { ...results, summary: applyPassRule(results.runs) },
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
  const tasks = loadTasks(values.tasks?.split(","));
  const resultsFile = resultsFileFor(values.label);
  const cliVersion = claudeVersion();
  const results: RoutingResults = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, "utf8"))
    : {
        label: values.label,
        confidence: INDICATIVE_NOTE,
        sessionModel: SESSION_MODEL,
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
  const isDone = (cell: { task: string; arm: RoutingArm; repeat: number }) =>
    results.runs.some(
      (run) =>
        run.task === cell.task &&
        run.arm === cell.arm &&
        run.repeat === cell.repeat,
    );
  const planned = plannedCells(
    tasks.map((task) => task.name),
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
      model: SESSION_MODEL,
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
