import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  type Arm,
  announcedSkills,
  assessRunIn,
  BUILD_TOOLS,
  type ClaudeRunner,
  createResultsFile,
  currentCommit,
  DEFAULT_SKILL_REF,
  designSkillNames,
  EVAL_ROOT,
  ISOLATION_NOTE,
  installArm,
  newBatchId,
  parseArm,
  parseModel,
  redactHome,
  reportedModel,
  resultsPath,
  runUsage,
  saveResults,
  spawnClaude,
  sumUsage,
  transcriptsDirectory,
} from "./claude.js";

const BUILD_MAX_TURNS = 40;
const DEFAULT_MAX_BUDGET_USD = 5;
const BRIEFS_DIRECTORY = join(EVAL_ROOT, "briefs");
const FIXTURES_DIRECTORY = join(EVAL_ROOT, "fixtures");

export interface OutputCase {
  brief: string;
  projectDirectory: string;
  transcriptPath: string;
  exitCode: number | null;
  status: "ok" | "errored" | "fatal";
  errorReason?: string;
  contaminated: boolean;
  announcedSkillCount: number;
  costUsd?: number;
  numTurns?: number;
}

export interface OutputOptions {
  arm: Arm;
  brief: string;
  runner: ClaudeRunner;
  workRoot: string;
  transcriptDirectory: string;
  skillRef?: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
}

export function briefNames(): string[] {
  return readdirSync(BRIEFS_DIRECTORY)
    .map((file) => basename(file, ".md"))
    .sort();
}

export async function runOutputBuild(options: OutputOptions) {
  if (!briefNames().includes(options.brief)) {
    throw new Error(
      `unknown brief ${JSON.stringify(options.brief)}; choose one of: ${briefNames().join(", ")}`,
    );
  }
  mkdirSync(options.transcriptDirectory, { recursive: true });
  const projectDirectory = mkdtempSync(
    join(options.workRoot, `${options.brief}-`),
  );
  const fixture = join(FIXTURES_DIRECTORY, options.brief);
  if (existsSync(fixture))
    cpSync(fixture, projectDirectory, { recursive: true });
  installArm(projectDirectory, options.arm, options.skillRef);
  const run = await options.runner({
    cwd: projectDirectory,
    prompt: readFileSync(join(BRIEFS_DIRECTORY, `${options.brief}.md`), "utf8"),
    maxTurns: BUILD_MAX_TURNS,
    permissionMode: "acceptEdits",
    tools: BUILD_TOOLS,
    model: options.model,
    effort: options.effort,
    maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
  });
  const assessment = assessRunIn(run, projectDirectory);
  const transcriptFile = join(
    options.transcriptDirectory,
    `${options.brief}.jsonl`,
  );
  writeFileSync(transcriptFile, run.transcript, { flag: "wx" });
  const announced = designSkillNames(announcedSkills(run.transcript));
  const outputCase: OutputCase = {
    brief: options.brief,
    projectDirectory: redactHome(projectDirectory),
    transcriptPath: relative(EVAL_ROOT, transcriptFile),
    exitCode: run.exitCode,
    status: assessment.status,
    errorReason: assessment.reason,
    announcedSkillCount: announcedSkills(run.transcript).length,
    ...runUsage(run.transcript),
    contaminated:
      options.arm === "A"
        ? announced.length > 0
        : announced.some((name) => name.includes(":")),
  };
  return { case: outputCase, model: reportedModel(run.transcript) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string" },
      brief: { type: "string" },
      label: { type: "string", default: "output" },
      model: { type: "string" },
      effort: { type: "string" },
      "skill-ref": { type: "string", default: DEFAULT_SKILL_REF },
      "max-budget-usd": {
        type: "string",
        default: String(DEFAULT_MAX_BUDGET_USD),
      },
    },
  });
  const arm = parseArm(values.arm);
  if (!values.brief)
    throw new Error(`--brief is required: ${briefNames().join(", ")}`);
  const maxBudgetUsd = Number(values["max-budget-usd"]);
  if (!(maxBudgetUsd > 0)) throw new Error("--max-budget-usd must be positive");
  const outputPath = resultsPath(
    values.label as string,
    arm,
    newBatchId(),
    values.brief,
  );
  const header = {
    model: "unknown",
    effort: values.effort ?? "default",
    agemonCommit: currentCommit(),
    arm,
    skillRef: values["skill-ref"] as string,
    isolationNote: ISOLATION_NOTE,
    cases: [] as OutputCase[],
  };
  createResultsFile(outputPath, header);
  const { case: outputCase, model } = await runOutputBuild({
    arm,
    brief: values.brief,
    runner: spawnClaude,
    workRoot: mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "design-eval-")),
    transcriptDirectory: transcriptsDirectory(outputPath),
    skillRef: header.skillRef,
    model: parseModel(values.model),
    effort: values.effort,
    maxBudgetUsd,
  });
  saveResults(outputPath, {
    ...header,
    ...sumUsage([outputCase]),
    model: model ?? values.model ?? "unknown",
    contaminated: outputCase.contaminated || undefined,
    cases: [outputCase],
  });
  console.log(
    `build directory (delete when done): ${outputCase.projectDirectory}`,
  );
  console.log(`results: ${outputPath}`);
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
