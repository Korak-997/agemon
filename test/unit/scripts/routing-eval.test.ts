import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRun } from "../../../scripts/design-eval/claude.js";
import { generateLargeBase } from "../../../scripts/routing-eval/large-base.js";
import {
  agentCallCounts,
  applyPassRule,
  costByModel,
  gradeAnswer,
  gradeReview,
  gradeTests,
  installRouting,
  LARGE_BASE_SEED,
  loadTasks,
  plannedCells,
  prepareProject,
  type RoutingRun,
  runCell,
  totalTurns,
} from "../../../scripts/routing-eval/run.js";
import {
  bootstrapDifference,
  costPerSolvedTask,
} from "../../../scripts/routing-eval/stats.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/routing-eval");
const ROUTING_ROOT = resolve(import.meta.dirname, "../../../evals/routing");
const recorded = (name: string) =>
  readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");

function run(overrides: Partial<RoutingRun>): RoutingRun {
  return {
    task: "t",
    arm: "N",
    repeat: 1,
    passed: true,
    turns: 1,
    costUsd: 1,
    costByModel: {},
    agentCalls: 0,
    agentCallsWithModel: 0,
    agentCallsToRoleAgents: 0,
    ...overrides,
  };
}

function filesUnder(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path.slice(root.length + 1), readFileSync(path, "utf8"));
  }
  return files;
}

function lastStatusByRequest(log: string): Map<string, string> {
  const lastStatus = new Map<string, string>();
  for (const match of log.matchAll(/request=(\S+) .*status=(\d+)/gu)) {
    lastStatus.set(match[1], match[2]);
  }
  return lastStatus;
}

function testsPassIn(directory: string): boolean {
  try {
    execFileSync("node", ["--test"], { cwd: directory, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("routing eval", () => {
  let workRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "routing-eval-test-"));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  describe("scoring recorded transcripts", () => {
    it("reads costByModel from modelUsage, which includes subagents", () => {
      expect(costByModel(recorded("subagent-run"))).toEqual({
        "claude-haiku-5-5": 0.02,
        "claude-opus-5-5": 0.3,
      });
    });

    it("counts Agent calls, the ones naming a model and those to role agents", () => {
      expect(agentCallCounts(recorded("subagent-run"))).toEqual({
        agentCalls: 3,
        agentCallsWithModel: 1,
        agentCallsToRoleAgents: 1,
        agentCallsByModel: {},
      });
    });

    it("counts subagents by the model their first message ran on", () => {
      expect(
        agentCallCounts(recorded("background-subagents-run")).agentCallsByModel,
      ).toEqual({ "claude-sonnet-5-5": 1, "claude-haiku-5-5": 1 });
    });

    it("adds up turns across a background session's result events", () => {
      expect(totalTurns(recorded("background-subagents-run"))).toBe(6);
    });

    it("takes cost per model from the last result event, which is cumulative", () => {
      const costs = costByModel(recorded("background-subagents-run"));
      expect(Object.keys(costs)).toHaveLength(3);
      expect(costs["claude-opus-5-5"]).toBeCloseTo(0.0917364);
      expect(costs["claude-sonnet-5-5"]).toBeCloseTo(0.0292597);
      expect(costs["claude-haiku-5-5"]).toBeCloseTo(0.00074744);
    });

    const scoreRecorded = (transcript: string, failure?: "timeout") =>
      runCell({
        task: {
          name: "t",
          prompt: "p",
          base: "small",
          grader: { kind: "answer", answer: "a.js#b" },
        },
        arm: "N",
        repeat: 1,
        workRoot,
        transcriptDirectory: join(workRoot, "transcripts"),
        maxBudgetUsd: 5,
        runner: async (): Promise<ClaudeRun> => ({
          transcript,
          exitCode: failure ? null : 0,
          failure,
        }),
      });

    it("fails an over-budget run even with a right answer, and keeps its cost", async () => {
      const { run: scored } = await scoreRecorded(recorded("over-budget-run"));
      expect(scored?.passed).toBe(false);
      expect(scored?.failure).toContain("error_max_budget_usd");
      expect(scored?.costUsd).toBe(5.01);
      expect(scored?.costIsCapEstimate).toBeUndefined();
    });

    it("fails a timed-out run and charges it the budget cap, marked as an estimate", async () => {
      const { run: scored } = await scoreRecorded(
        recorded("timed-out-run"),
        "timeout",
      );
      expect(scored?.passed).toBe(false);
      expect(scored?.failure).toBe("timeout");
      expect(scored?.costUsd).toBe(5);
      expect(scored?.costIsCapEstimate).toBe(true);
    });

    it("stops the batch and records nothing on a usage limit", async () => {
      const { run: scored, abort } = await scoreRecorded(
        recorded("usage-limit-run"),
      );
      expect(scored).toBeUndefined();
      expect(abort).toContain("usage-limit-or-auth");
    });

    it("stops the batch if arm N can see a role agent", async () => {
      const { run: scored, abort } = await scoreRecorded(
        recorded("subagent-run"),
      );
      expect(scored).toBeUndefined();
      expect(abort).toContain("agemon-scout");
    });
  });

  describe("graders", () => {
    it("accepts only a single answer token, and only the right one", () => {
      const answer = "src/a.js#run";
      expect(gradeAnswer("It is `src/a.js#run`", answer)).toBe(true);
      expect(gradeAnswer("It is src/b.js#run", answer)).toBe(false);
      expect(gradeAnswer("src/a.js#run or src/b.js#go", answer)).toBe(false);
      expect(gradeAnswer("no token, just src/a.js", answer)).toBe(false);
    });

    it("accepts a log request id as an answer token", () => {
      const answer = "logs/app.log#req-0a1b2c3d";
      expect(gradeAnswer("It failed: logs/app.log#req-0a1b2c3d", answer)).toBe(
        true,
      );
      expect(
        gradeAnswer("logs/app.log#req-0a1b2c3d or logs/app.log#req-9", answer),
      ).toBe(false);
    });

    it("needs the review to name a planted line", () => {
      const grader = {
        kind: "review",
        file: "src/a/assign.js",
        lines: [7, 13],
      } as const;
      expect(gradeReview("`src/a/assign.js:7` overloads", grader)).toBe(true);
      expect(gradeReview("src/a/assign.js:13-14 is wrong", grader)).toBe(true);
      expect(gradeReview("src/a/assign.js:8 is wrong", grader)).toBe(false);
      expect(gradeReview("src/a/other.js:7 is wrong", grader)).toBe(false);
    });

    it("restores the fixture's tests before grading, so editing a test cannot pass", async () => {
      const [task] = loadTasks(["bug-invoice-total"]);
      await prepareProject(workRoot, task);
      writeFileSync(join(workRoot, "test", "invoice-discount.js"), "");
      writeFileSync(join(workRoot, "test", "quote.js"), "");
      expect(await gradeTests(workRoot, task)).toBe(false);
    });

    it("grades the correct code as a pass", async () => {
      const [task] = loadTasks(["bug-invoice-total"]);
      await prepareProject(workRoot, task);
      cpSync(join(ROUTING_ROOT, "base", "src"), join(workRoot, "src"), {
        recursive: true,
      });
      expect(await gradeTests(workRoot, task)).toBe(true);
    });
  });

  describe("arms", () => {
    const AGENTS_FILE = "AGENTS.md";
    const SUBAGENT_SECTION = "## Subagent Models";
    const EXPLORE_AGENT = ".claude/agents/explore.md";
    const ROLE_AGENTS = [
      ".claude/agents/agemon-scout.md",
      ".claude/agents/agemon-worker.md",
    ];
    const SETTINGS = ".claude/settings.json";

    it("arm N writes no explore.md and no role agents", async () => {
      await installRouting(workRoot, "N");
      const rules = readFileSync(join(workRoot, AGENTS_FILE), "utf8");
      expect(rules).not.toContain(SUBAGENT_SECTION);
      expect(rules).toContain("## Core Directives");
      expect(rules).toContain("## Output Conventions");
      expect(readFileSync(join(workRoot, "CLAUDE.md"), "utf8")).toContain(
        AGENTS_FILE,
      );
      for (const agentFile of [EXPLORE_AGENT, ...ROLE_AGENTS]) {
        expect(existsSync(join(workRoot, agentFile)), agentFile).toBe(false);
      }
      expect(existsSync(join(workRoot, SETTINGS))).toBe(false);
    });

    it("arm A writes explore.md, agemon-scout.md, agemon-worker.md and the env key", async () => {
      await installRouting(workRoot, "A");
      expect(readFileSync(join(workRoot, AGENTS_FILE), "utf8")).toContain(
        SUBAGENT_SECTION,
      );
      expect(readFileSync(join(workRoot, EXPLORE_AGENT), "utf8")).toMatch(
        /^---\nname: Explore\n[\s\S]*model: haiku\n/u,
      );
      for (const agentFile of ROLE_AGENTS) {
        expect(existsSync(join(workRoot, agentFile)), agentFile).toBe(true);
      }
      expect(
        JSON.parse(readFileSync(join(workRoot, SETTINGS), "utf8")),
      ).toEqual({
        env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      });
    });

    it('arms C and G throw "arm C needs Phase 4" / "arm G needs Phase 5" until their installers exist', async () => {
      await expect(installRouting(workRoot, "C")).rejects.toThrow(
        "arm C needs Phase 4",
      );
      await expect(installRouting(workRoot, "G")).rejects.toThrow(
        "arm G needs Phase 5",
      );
    });
  });

  describe("stats", () => {
    it("costPerSolvedTask divides total cost by passed runs and is Infinity when none passed", () => {
      expect(
        costPerSolvedTask([
          run({ costUsd: 1 }),
          run({ costUsd: 2, passed: false }),
          run({ costUsd: 3 }),
        ]),
      ).toBe(3);
      expect(costPerSolvedTask([run({ passed: false })])).toBe(
        Number.POSITIVE_INFINITY,
      );
    });

    it("bootstrapDifference is deterministic for a fixed seed", () => {
      const baseline = [1, 1.4, 0.8, 1.2].map((costUsd, index) =>
        run({ task: `t${index % 2}`, costUsd }),
      );
      const candidate = [0.7, 0.9, 0.5, 1.1].map((costUsd, index) =>
        run({ arm: "A", task: `t${index % 2}`, costUsd }),
      );
      const first = bootstrapDifference(baseline, candidate, 500, 7);
      expect(bootstrapDifference(baseline, candidate, 500, 7)).toEqual(first);
      expect(first.meanDifference).toBeCloseTo(-0.3);
      expect(first.low).toBeLessThanOrEqual(first.high);
    });
  });

  describe("pass rule", () => {
    const TASKS = ["t1", "t2", "t3"];
    const arm = (
      name: RoutingRun["arm"],
      costEach: (task: string, repeat: number) => number,
      failures: readonly string[] = [],
    ) =>
      TASKS.flatMap((task) =>
        [1, 2, 3, 4].map((repeat) =>
          run({
            task,
            arm: name,
            repeat,
            costUsd: costEach(task, repeat),
            passed: !failures.includes(`${task}r${repeat}`),
          }),
        ),
      );
    const noisyCost = (task: string, repeat: number) =>
      1 + TASKS.indexOf(task) * 0.2 + repeat * 0.05;

    it("pass rule: candidate passes only when pass count is within 1 of baseline per task and the 95% interval of (candidate − baseline) cost per solved task lies entirely below 0", () => {
      const baseline = arm("N", noisyCost);
      const cheaper = (task: string, repeat: number) =>
        noisyCost(task, repeat) * 0.6;
      const passing = applyPassRule(
        [...baseline, ...arm("A", cheaper, ["t1r1"])],
        "N",
      );
      expect(passing.A?.costPerSolvedTaskDifference?.high).toBeLessThan(0);
      expect(passing.A?.passes).toBe(true);

      const twoFewerOnOneTask = applyPassRule(
        [...baseline, ...arm("A", cheaper, ["t1r1", "t1r2"])],
        "N",
      );
      expect(twoFewerOnOneTask.A?.passes).toBe(false);

      const notClearlyCheaper = applyPassRule(
        [
          ...baseline,
          ...arm("A", (task, repeat) => noisyCost(task, 5 - repeat)),
        ],
        "N",
      );
      expect(
        notClearlyCheaper.A?.costPerSolvedTaskDifference?.high,
      ).toBeGreaterThanOrEqual(0);
      expect(notClearlyCheaper.A?.passes).toBe(false);
    });

    it("gives no verdict until the arms have the same number of runs", () => {
      const rule = applyPassRule(
        [...arm("N", noisyCost), run({ arm: "A" })],
        "N",
      );
      expect(rule.A?.passes).toBeNull();
      expect(rule.A?.costPerSolvedTaskDifference).toBeNull();
    });

    it("reports cost per solved task, agent calls by model and the top task's share", () => {
      const rule = applyPassRule(
        [
          run({ arm: "N", turns: 4 }),
          run({
            task: "t1",
            arm: "A",
            turns: 6,
            costUsd: 3,
            agentCalls: 4,
            agentCallsWithModel: 1,
            agentCallsToRoleAgents: 2,
            agentCallsByModel: { "claude-haiku-5-5": 3 },
          }),
          run({
            task: "t2",
            arm: "A",
            costUsd: 1,
            passed: false,
            agentCallsByModel: { "claude-haiku-5-5": 1 },
          }),
        ],
        "N",
      );
      expect(rule.A?.turns).toBe(7);
      expect(rule.A?.costPerSolvedTask).toBe(4);
      expect(rule.A?.agentCallsByModel).toEqual({ "claude-haiku-5-5": 4 });
      expect(rule.A?.mostExpensiveTaskShare).toBe(0.75);
      expect(rule.A?.shareNamingModel).toBe(0.25);
      expect(rule.A?.shareToRoleAgents).toBe(0.5);
      expect(rule.N?.shareNamingModel).toBeNull();
    });

    it("summarizes a results file written before arms A, C and G", () => {
      const { runs } = JSON.parse(
        readFileSync(
          join(ROUTING_ROOT, "results", "2026-11-06-full.json"),
          "utf8",
        ),
      );
      const rule = applyPassRule(runs, "N");
      expect(Object.keys(rule)).toEqual(
        expect.arrayContaining(["N", "R", "RD"]),
      );
      expect(rule.R?.passed).toBe(12);
      expect(rule.R?.agentCallsByModel).toEqual({});
      expect(typeof rule.R?.passes).toBe("boolean");
    });
  });

  describe("the plan", () => {
    it("covers every task x arm x repeat with every arm first equally often", () => {
      const names = loadTasks().map((task) => task.name);
      expect(names).toHaveLength(9);
      const cells = plannedCells(names, ["N", "A"], 2);
      expect(cells).toHaveLength(36);
      expect(
        new Set(cells.map((c) => `${c.task}|${c.arm}|${c.repeat}`)).size,
      ).toBe(36);
      const firsts = cells
        .filter((_, index) => index % 2 === 0)
        .map((cell) => cell.arm);
      for (const arm of ["N", "A"]) {
        expect(firsts.filter((first) => first === arm)).toHaveLength(9);
      }
    });
  });

  describe("large base", () => {
    const SOURCE_FILE = /^src\/.*\.js$/u;
    const MIN_SOURCE_LINES = 60;
    const MAX_SOURCE_LINES = 120;

    it("generateLargeBase is deterministic", async () => {
      await generateLargeBase(join(workRoot, "first"), 7);
      await generateLargeBase(join(workRoot, "second"), 7);
      expect(filesUnder(join(workRoot, "second"))).toEqual(
        filesUnder(join(workRoot, "first")),
      );
    });

    it("generateLargeBase writes at least 400 source files of 60–120 lines", async () => {
      await generateLargeBase(workRoot, LARGE_BASE_SEED);
      const sources = [...filesUnder(workRoot)].filter(([path]) =>
        SOURCE_FILE.test(path),
      );
      expect(sources.length).toBeGreaterThanOrEqual(400);
      for (const [path, contents] of sources) {
        const lines = contents.trimEnd().split("\n").length;
        expect(lines, path).toBeGreaterThanOrEqual(MIN_SOURCE_LINES);
        expect(lines, path).toBeLessThanOrEqual(MAX_SOURCE_LINES);
      }
    });

    it("each large task's answer exists exactly once in the generated tree", async () => {
      await generateLargeBase(workRoot, LARGE_BASE_SEED);
      const files = filesUnder(workRoot);
      const largeTasks = loadTasks().filter((task) => task.base === "large");
      expect(largeTasks.map((task) => task.name).sort()).toEqual([
        "large-config-origin",
        "large-trace-caller",
        "log-digest-failure",
      ]);
      for (const { name, grader } of largeTasks) {
        if (grader.kind !== "answer") throw new Error(`${name} needs answer`);
        const [file, identifier] = grader.answer.split("#");
        if (file.endsWith(".log")) {
          const failedForGood = [
            ...lastStatusByRequest(files.get(file) ?? ""),
          ].filter(([, status]) => status === "500");
          expect(failedForGood, name).toEqual([[identifier, "500"]]);
          expect((files.get(file) ?? "").split("\n").length - 1).toBe(5000);
          continue;
        }
        const definition = `export function ${identifier}(`;
        const definedIn = [...files]
          .filter(([, contents]) => contents.includes(definition))
          .map(([path]) => path);
        expect(definedIn, name).toEqual([file]);
        expect(files.get(file)?.split(definition)).toHaveLength(2);
      }
    });
  });

  describe("fixtures", () => {
    it("has a passing base, so a task failure comes from the task", () => {
      expect(testsPassIn(join(ROUTING_ROOT, "base"))).toBe(true);
    });

    it("gives test-graded tasks work to do", async () => {
      for (const task of loadTasks()) {
        if (task.grader.kind !== "tests") continue;
        const project = join(workRoot, task.name);
        mkdirSync(project);
        await prepareProject(project, task);
        expect(testsPassIn(project), task.name).toBe(false);
      }
    });

    it("points answer graders at functions that exist", () => {
      for (const { name, grader, base } of loadTasks()) {
        if (grader.kind !== "answer" || base !== "small") continue;
        const [file, functionName] = grader.answer.split("#");
        expect(
          readFileSync(join(ROUTING_ROOT, "base", file), "utf8"),
          name,
        ).toContain(`export function ${functionName}(`);
      }
    });

    it("plants the review bug on the graded lines", () => {
      const [task] = loadTasks(["review-split-dispatch"]);
      if (task.grader.kind !== "review") throw new Error("expected a review");
      const lines = readFileSync(
        join(ROUTING_ROOT, "tasks", task.name, "overlay", task.grader.file),
        "utf8",
      ).split("\n");
      const gradedText = task.grader.lines
        .map((line) => lines[line - 1])
        .join("\n");
      expect(gradedText).toContain("vanFits(van, parcel)");
      expect(gradedText).toContain("van.loadKg +=");
    });
  });
});
