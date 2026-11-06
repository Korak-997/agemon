import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  ACTIVATION_TOOLS,
  type Arm,
  activatedSkills,
  announcedSkills,
  assessRunIn,
  type ClaudeRunner,
  createResultsFile,
  currentCommit,
  DEFAULT_SKILL_REF,
  designSkillNames,
  EVAL_ROOT,
  ISOLATION_NOTE,
  installArm,
  newBatchId,
  PROJECT_DESIGN_SKILL,
  parseArm,
  parseModel,
  reportedModel,
  resultsPath,
  runUsage,
  saveResults,
  spawnClaude,
  sumUsage,
  transcriptsDirectory,
} from "./claude.js";

const ACTIVATION_MAX_TURNS = 4;
const MAX_RUNS_PER_INVOCATION = 6;
const TRAIN_FRACTION = 0.6;
const ACTIVATION_KINDS = [
  "clear",
  "small-edit",
  "near-miss",
  "guidelines-boundary",
] as const;

export type ActivationKind = (typeof ACTIVATION_KINDS)[number];

export interface ActivationCase {
  prompt: string;
  expected: "trigger" | "no-trigger";
  kind: ActivationKind;
  track?: "small-edit" | "in-brand-feature" | "new-surface" | "review-only";
}

export interface ActivationRun {
  kind: ActivationKind;
  expected: ActivationCase["expected"];
  activated: boolean;
  prompt?: string;
  errored?: boolean;
  errorReason?: string;
  contaminated?: boolean;
  invokedDesignSkills?: string[];
  namespacedCall?: boolean;
  exitCode?: number | null;
  announcedSkillCount?: number;
  costUsd?: number;
  numTurns?: number;
  transcriptPath?: string;
}

export interface KindScore {
  correct: number;
  total: number;
  rate: number | null;
  errored: number;
  contaminated: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function splitCases(cases: ActivationCase[], seed: number) {
  const random = seededRandom(seed);
  const shuffled = [...cases];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapWith = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith] as ActivationCase,
      shuffled[index] as ActivationCase,
    ];
  }
  const trainSize = Math.round(shuffled.length * TRAIN_FRACTION);
  return {
    train: shuffled.slice(0, trainSize),
    validation: shuffled.slice(trainSize),
  };
}

export function scoreActivation(
  runs: ActivationRun[],
): Record<ActivationKind, KindScore> {
  const score = {} as Record<ActivationKind, KindScore>;
  for (const kind of ACTIVATION_KINDS) {
    const ofKind = runs.filter((entry) => entry.kind === kind);
    const errored = ofKind.filter((entry) => entry.errored).length;
    const contaminated = ofKind.filter(
      (entry) => !entry.errored && entry.contaminated,
    ).length;
    const scored = ofKind.filter(
      (entry) => !entry.errored && !entry.contaminated,
    );
    const correct = scored.filter(
      (entry) => entry.activated === (entry.expected === "trigger"),
    ).length;
    score[kind] = {
      correct,
      total: scored.length,
      rate: scored.length === 0 ? null : correct / scored.length,
      errored,
      contaminated,
    };
  }
  return score;
}

export function planBatch(
  cases: ActivationCase[],
  {
    offset,
    limit,
    runsPerCase,
  }: { offset: number; limit: number; runsPerCase: number },
): ActivationCase[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit is required and must be a positive integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }
  if (!Number.isInteger(runsPerCase) || runsPerCase < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (limit * runsPerCase > MAX_RUNS_PER_INVOCATION) {
    throw new Error(
      `${limit} cases x ${runsPerCase} runs exceeds the cap of ${MAX_RUNS_PER_INVOCATION} runs per invocation`,
    );
  }
  return cases.slice(offset, offset + limit);
}

export interface ActivationOptions {
  cases: ActivationCase[];
  runsPerCase: number;
  arm: Arm;
  runner: ClaudeRunner;
  workRoot: string;
  skillRef?: string;
  model?: string;
  effort?: string;
  allowContaminated?: boolean;
  transcriptDirectory?: string;
  save?: (state: {
    runs: ActivationRun[];
    model?: string;
    aborted?: string;
  }) => void;
}

function isContaminated(
  arm: Arm,
  announced: string[],
  invoked: string[],
): boolean {
  const foreignAnnounced =
    arm === "A" ? announced : announced.filter((name) => name.includes(":"));
  return foreignAnnounced.length > 0 || (arm === "A" && invoked.length > 0);
}

export async function runActivation(options: ActivationOptions) {
  const runs: ActivationRun[] = [];
  let model: string | undefined;
  let aborted: string | undefined;
  const snapshot = () => options.save?.({ runs, model, aborted });
  runLoop: for (const activationCase of options.cases) {
    for (let attempt = 0; attempt < options.runsPerCase; attempt++) {
      const projectDirectory = mkdtempSync(
        join(options.workRoot, "activation-"),
      );
      try {
        installArm(projectDirectory, options.arm, options.skillRef);
        const run = await options.runner({
          cwd: projectDirectory,
          prompt: activationCase.prompt,
          maxTurns: ACTIVATION_MAX_TURNS,
          permissionMode: "plan",
          tools: ACTIVATION_TOOLS,
          model: options.model,
          effort: options.effort,
        });
        model ??= reportedModel(run.transcript);
        const assessment = assessRunIn(run, projectDirectory);
        const invoked = designSkillNames(activatedSkills(run.transcript));
        const record: ActivationRun = {
          prompt: activationCase.prompt,
          kind: activationCase.kind,
          expected: activationCase.expected,
          activated:
            options.arm === "B" && invoked.includes(PROJECT_DESIGN_SKILL),
          errored: assessment.status !== "ok",
          errorReason: assessment.reason,
          contaminated: isContaminated(
            options.arm,
            designSkillNames(announcedSkills(run.transcript)),
            invoked,
          ),
          invokedDesignSkills: invoked,
          namespacedCall: invoked.some((name) => name.includes(":")),
          exitCode: run.exitCode,
          announcedSkillCount: announcedSkills(run.transcript).length,
          ...runUsage(run.transcript),
        };
        if (options.transcriptDirectory) {
          mkdirSync(options.transcriptDirectory, { recursive: true });
          const transcriptFile = join(
            options.transcriptDirectory,
            `${runs.length}.jsonl`,
          );
          writeFileSync(transcriptFile, run.transcript, { flag: "wx" });
          record.transcriptPath = relative(EVAL_ROOT, transcriptFile);
        }
        runs.push(record);
        snapshot();
        if (assessment.status === "fatal" || assessment.abortsBatch) {
          aborted = assessment.reason;
          break runLoop;
        }
        if (record.contaminated && !options.allowContaminated) {
          aborted =
            "contaminated: a non-project agemon-design skill is visible";
          break runLoop;
        }
      } finally {
        rmSync(projectDirectory, { recursive: true, force: true });
      }
    }
  }
  if (runs.some((entry) => entry.contaminated)) {
    for (const entry of runs) entry.contaminated = true;
  }
  snapshot();
  return { runs, model, aborted };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string" },
      label: { type: "string", default: "activation" },
      runs: { type: "string", default: "2" },
      split: { type: "string", default: "all" },
      seed: { type: "string", default: "1" },
      limit: { type: "string" },
      offset: { type: "string", default: "0" },
      model: { type: "string" },
      effort: { type: "string" },
      "skill-ref": { type: "string", default: DEFAULT_SKILL_REF },
      "allow-contaminated": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const allCases = JSON.parse(
    readFileSync(join(EVAL_ROOT, "activation-cases.json"), "utf8"),
  ) as ActivationCase[];
  const split = splitCases(allCases, Number(values.seed));
  const pool =
    values.split === "train"
      ? split.train
      : values.split === "validation"
        ? split.validation
        : allCases;
  const runsPerCase = Number(values.runs);
  if (values["dry-run"]) {
    const limit = values.limit ? Number(values.limit) : pool.length;
    console.log(
      `dry run: ${pool.length} cases in pool; batches of ${limit} cases x ${runsPerCase} runs; cap ${MAX_RUNS_PER_INVOCATION} runs per invocation`,
    );
    return;
  }
  const arm = parseArm(values.arm);
  const cases = planBatch(pool, {
    offset: Number(values.offset),
    limit: Number(values.limit),
    runsPerCase,
  });
  const batchId = newBatchId();
  const outputPath = resultsPath(values.label as string, arm, batchId);
  const header = {
    model: "unknown",
    effort: values.effort ?? "default",
    agemonCommit: currentCommit(),
    arm,
    skillRef: values["skill-ref"] as string,
    isolationNote: ISOLATION_NOTE,
    cases: [] as ActivationRun[],
  };
  createResultsFile(outputPath, header);
  const workRoot = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "design-eval-"),
  );
  try {
    const { runs, aborted } = await runActivation({
      cases,
      runsPerCase,
      arm,
      runner: spawnClaude,
      workRoot,
      skillRef: header.skillRef,
      model: parseModel(values.model),
      effort: values.effort,
      allowContaminated: values["allow-contaminated"],
      transcriptDirectory: transcriptsDirectory(outputPath),
      save: ({ runs: savedRuns, model, aborted: reason }) =>
        saveResults(outputPath, {
          ...header,
          model: model ?? values.model ?? "unknown",
          contaminated:
            savedRuns.some((entry) => entry.contaminated) || undefined,
          aborted: reason,
          ...sumUsage(savedRuns),
          cases: savedRuns,
        }),
    });
    console.log(JSON.stringify(scoreActivation(runs), null, 2));
    if (aborted) console.log(`ABORTED: ${aborted}`);
    console.log(`results: ${outputPath}`);
    process.exitCode = aborted ? 1 : 0;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
