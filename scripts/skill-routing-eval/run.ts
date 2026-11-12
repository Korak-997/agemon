import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderRuleFileContents } from "../../src/plugins/master-prompt/index.js";
import { SKILL_GROUPS } from "../../src/plugins/skills/catalog.js";
import {
  activatedSkills,
  announcedSkills,
  assessRunIn,
  type ClaudeRunner,
  currentCommit,
  newBatchId,
  parseModel,
  redactHome,
  reportedModel,
  runUsage,
  spawnClaude,
  sumUsage,
  transcriptsDirectory,
} from "../design-eval/claude.js";
import {
  assertSkillToolWasUsed,
  classifyInvocations,
  type SkillRoutingArm,
  type SkillRoutingCase,
  type SkillRoutingRun,
  summarizeSkillRouting,
} from "./score.js";

const EVAL_ROOT = resolve(import.meta.dirname, "../../evals/skill-routing");
const BASE_DIRECTORY = join(EVAL_ROOT, "base");
const CASES_FILE = join(EVAL_ROOT, "cases.json");
const AGENT_RULES_FILE = "AGENTS.md";
const POINTER_FILE = "CLAUDE.md";
const SKILL_ROUTING_TOOLS = "Skill,Read,Glob,Grep";
const SKILL_ROUTING_MAX_TURNS = 4;
const DEFAULT_MODEL = "opus";
const DEFAULT_REPEATS = "2";
const PROBE_CASE_ID = "neg-explain-code";
const ISOLATION_NOTE =
  "Runs use only project and local settings, but account-synced skills stay listed; namespaced invocations are counted as foreign and left out of the outcome.";

export interface SkillRoutingOptions {
  cases: readonly SkillRoutingCase[];
  repeats: number;
  arm: SkillRoutingArm;
  runner: ClaudeRunner;
  workRoot: string;
  model?: string;
  effort?: string;
  transcriptDirectory?: string;
  save?: (state: {
    runs: SkillRoutingRun[];
    model?: string;
    aborted?: string;
  }) => void;
}

export function loadCases(): SkillRoutingCase[] {
  return JSON.parse(readFileSync(CASES_FILE, "utf8")) as SkillRoutingCase[];
}

export function evaluatedSkillNames(): Set<string> {
  return new Set(
    SKILL_GROUPS.flatMap((group) =>
      group.skills.map((skill) => skill.skillName),
    ),
  );
}

export function installArm(projectDirectory: string): void {
  writeFileSync(
    join(projectDirectory, AGENT_RULES_FILE),
    renderRuleFileContents(AGENT_RULES_FILE, null),
  );
  writeFileSync(
    join(projectDirectory, POINTER_FILE),
    renderRuleFileContents(POINTER_FILE, null),
  );
  const skillsDirectory = join(projectDirectory, ".claude", "skills");
  for (const skill of SKILL_GROUPS.flatMap((group) => group.skills)) {
    cpSync(skill.source, join(skillsDirectory, skill.skillName), {
      recursive: true,
    });
  }
}

export async function runSkillRouting(options: SkillRoutingOptions) {
  const evaluated = evaluatedSkillNames();
  const runs: SkillRoutingRun[] = [];
  let model: string | undefined;
  let aborted: string | undefined;
  const snapshot = () => options.save?.({ runs, model, aborted });
  runLoop: for (const routingCase of options.cases) {
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const projectDirectory = mkdtempSync(
        join(options.workRoot, "skill-routing-"),
      );
      try {
        cpSync(BASE_DIRECTORY, projectDirectory, { recursive: true });
        installArm(projectDirectory);
        const run = await options.runner({
          cwd: projectDirectory,
          prompt: routingCase.prompt,
          maxTurns: SKILL_ROUTING_MAX_TURNS,
          permissionMode: "plan",
          tools: SKILL_ROUTING_TOOLS,
          model: options.model,
          effort: options.effort,
        });
        model ??= reportedModel(run.transcript);
        const assessment = assessRunIn(run, projectDirectory);
        const invoked = activatedSkills(run.transcript);
        const { outcome, foreign } = classifyInvocations(
          invoked,
          routingCase.expected,
          evaluated,
        );
        const record: SkillRoutingRun = {
          caseId: routingCase.id,
          arm: options.arm,
          outcome,
          invoked,
          foreign,
          skillCalls: invoked.length,
          announcedSkillCount: announcedSkills(run.transcript).length,
          errored: assessment.status !== "ok",
          errorReason: assessment.reason,
          ...runUsage(run.transcript),
        };
        if (options.transcriptDirectory) {
          mkdirSync(options.transcriptDirectory, { recursive: true });
          const transcriptFile = join(
            options.transcriptDirectory,
            `${runs.length}.jsonl`,
          );
          writeFileSync(transcriptFile, redactHome(run.transcript), {
            flag: "wx",
          });
          record.transcriptPath = relative(EVAL_ROOT, transcriptFile);
        }
        runs.push(record);
        snapshot();
        if (assessment.status === "fatal" || assessment.abortsBatch) {
          aborted = assessment.reason;
          break runLoop;
        }
      } finally {
        rmSync(projectDirectory, { recursive: true, force: true });
      }
    }
  }
  snapshot();
  return { runs, model, aborted };
}

function parseSkillRoutingArm(value: string | undefined): SkillRoutingArm {
  if (value === "N") return value;
  throw new Error(`--arm must be N, got ${JSON.stringify(value)}`);
}

function parseRepeats(value: string): number {
  const repeats = Number(value);
  if (Number.isInteger(repeats) && repeats > 0) return repeats;
  throw new Error(
    `--repeats must be a positive integer, got ${JSON.stringify(value)}`,
  );
}

function selectCases(
  cases: SkillRoutingCase[],
  requestedIds: string[],
): SkillRoutingCase[] {
  const unknown = requestedIds.filter(
    (id) => !cases.some((entry) => entry.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown case id(s): ${unknown.join(", ")}`);
  }
  return cases.filter((entry) => requestedIds.includes(entry.id));
}

function resultsPath(
  label: string,
  arm: SkillRoutingArm,
  batchId: string,
): string {
  const date = batchId
    .slice(0, 8)
    .replace(/(\d{4})(\d{2})(\d{2})/u, "$1-$2-$3");
  return join(
    EVAL_ROOT,
    "results",
    `${date}-${label}-arm-${arm}-${batchId}.json`,
  );
}

function probeFindings(transcript: string): {
  missing: string[];
  foreign: string[];
} {
  const announced = announcedSkills(transcript);
  return {
    missing: [...evaluatedSkillNames()].filter(
      (name) => !announced.includes(name),
    ),
    foreign: announced.filter((name) => name.includes(":")),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string", default: "N" },
      repeats: { type: "string", default: DEFAULT_REPEATS },
      cases: { type: "string" },
      label: { type: "string", default: "skill-routing" },
      model: { type: "string", default: DEFAULT_MODEL },
      effort: { type: "string" },
      probe: { type: "boolean", default: false },
    },
  });
  const probe = values.probe;
  const arm = probe ? "N" : parseSkillRoutingArm(values.arm);
  const allCases = loadCases();
  const requestedIds = probe ? [PROBE_CASE_ID] : values.cases?.split(",");
  const cases = requestedIds ? selectCases(allCases, requestedIds) : allCases;
  const repeats = probe ? 1 : parseRepeats(values.repeats);
  const label = values.label;
  const outputPath = resultsPath(label, arm, newBatchId());
  const header = {
    model: values.model,
    effort: values.effort ?? "default",
    agemonCommit: currentCommit(),
    arm,
    isolationNote: ISOLATION_NOTE,
  };
  mkdirSync(join(EVAL_ROOT, "results"), { recursive: true });
  let lastTranscript = "";
  const runner: ClaudeRunner = async (request) => {
    const run = await spawnClaude(request);
    lastTranscript = run.transcript;
    return run;
  };
  const workRoot = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "skill-routing-eval-"),
  );
  try {
    const { runs, aborted } = await runSkillRouting({
      cases,
      repeats,
      arm,
      runner,
      workRoot,
      model: parseModel(values.model),
      effort: values.effort,
      transcriptDirectory: transcriptsDirectory(outputPath),
      save: ({ runs: savedRuns, model, aborted: reason }) =>
        writeFileSync(
          outputPath,
          `${JSON.stringify(
            {
              ...header,
              model: model ?? header.model,
              aborted: reason,
              ...sumUsage(savedRuns),
              summary: summarizeSkillRouting(savedRuns),
              runs: savedRuns,
            },
            null,
            2,
          )}\n`,
        ),
    });
    console.log(JSON.stringify(summarizeSkillRouting(runs), null, 2));
    console.log(`results: ${outputPath}`);
    if (aborted) {
      console.log(`ABORTED: ${aborted}`);
      process.exitCode = 1;
      return;
    }
    if (probe) {
      const { missing, foreign } = probeFindings(lastTranscript);
      console.log(`foreign skills listed: ${foreign.join(", ") || "none"}`);
      if (missing.length > 0 || runs.some((run) => run.errored)) {
        console.log(
          `PROBE FAILED: not listed: ${missing.join(", ") || "none"}`,
        );
        process.exitCode = 1;
      }
      return;
    }
    assertSkillToolWasUsed(runs);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
