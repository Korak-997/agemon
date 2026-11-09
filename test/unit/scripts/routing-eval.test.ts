import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRun } from "../../../scripts/design-eval/claude.js";
import {
  agentCallCounts,
  applyPassRule,
  costByModel,
  gradeAnswer,
  gradeReview,
  gradeTests,
  installRouting,
  loadTasks,
  plannedCells,
  prepareProject,
  type RoutingRun,
  runCell,
  totalTurns,
} from "../../../scripts/routing-eval/run.js";

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
      });
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
      prepareProject(workRoot, task);
      writeFileSync(join(workRoot, "test", "invoice-discount.js"), "");
      writeFileSync(join(workRoot, "test", "quote.js"), "");
      expect(await gradeTests(workRoot, task)).toBe(false);
    });

    it("grades the correct code as a pass", async () => {
      const [task] = loadTasks(["bug-invoice-total"]);
      prepareProject(workRoot, task);
      cpSync(join(ROUTING_ROOT, "base", "src"), join(workRoot, "src"), {
        recursive: true,
      });
      expect(await gradeTests(workRoot, task)).toBe(true);
    });
  });

  describe("arms", () => {
    const AGENTS_FILE = "AGENTS.md";
    const SUBAGENT_SECTION = "## Subagent Models";
    const ROLE_AGENT = ".claude/agents/agemon-scout.md";
    const SETTINGS = ".claude/settings.json";

    it("N has the same rules without the routing section, and no role agents", async () => {
      await installRouting(workRoot, "N");
      const rules = readFileSync(join(workRoot, AGENTS_FILE), "utf8");
      expect(rules).not.toContain(SUBAGENT_SECTION);
      expect(rules).toContain("## Core Directives");
      expect(rules).toContain("## Output Conventions");
      expect(readFileSync(join(workRoot, "CLAUDE.md"), "utf8")).toContain(
        AGENTS_FILE,
      );
      expect(existsSync(join(workRoot, ROLE_AGENT))).toBe(false);
      expect(existsSync(join(workRoot, SETTINGS))).toBe(false);
    });

    it("R adds the routing section and pinned role agents", async () => {
      await installRouting(workRoot, "R");
      expect(readFileSync(join(workRoot, AGENTS_FILE), "utf8")).toContain(
        SUBAGENT_SECTION,
      );
      expect(readFileSync(join(workRoot, ROLE_AGENT), "utf8")).toContain(
        "model: haiku",
      );
      expect(existsSync(join(workRoot, SETTINGS))).toBe(false);
    });

    it("RD also sets the subagent default in the fixture's settings", async () => {
      await installRouting(workRoot, "RD");
      expect(existsSync(join(workRoot, ROLE_AGENT))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(workRoot, SETTINGS), "utf8")),
      ).toEqual({
        env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      });
    });
  });

  describe("pass rule", () => {
    const arm = (name: RoutingRun["arm"], passes: number, costEach: number) =>
      Array.from({ length: 12 }, (_, index) =>
        run({ arm: name, passed: index < passes, costUsd: costEach }),
      );

    it("passes at one fewer passing run and 20% lower cost", () => {
      const rule = applyPassRule([...arm("N", 12, 1), ...arm("R", 11, 0.8)]);
      expect(rule.R?.passes).toBe(true);
    });

    it("fails at two fewer passing runs", () => {
      const rule = applyPassRule([...arm("N", 12, 1), ...arm("R", 10, 0.5)]);
      expect(rule.R?.passes).toBe(false);
    });

    it("fails when the saving is under 20%", () => {
      const rule = applyPassRule([...arm("N", 12, 1), ...arm("R", 12, 0.81)]);
      expect(rule.R?.passes).toBe(false);
    });

    it("gives no verdict until the arms have the same number of runs", () => {
      const rule = applyPassRule([...arm("N", 12, 1), run({ arm: "R" })]);
      expect(rule.R?.passes).toBeNull();
    });

    it("reports turns and the share of Agent calls naming a model", () => {
      const rule = applyPassRule([
        run({ arm: "N", turns: 4 }),
        run({
          arm: "R",
          turns: 6,
          agentCalls: 4,
          agentCallsWithModel: 1,
          agentCallsToRoleAgents: 2,
        }),
      ]);
      expect(rule.R?.turns).toBe(6);
      expect(rule.R?.shareNamingModel).toBe(0.25);
      expect(rule.R?.shareToRoleAgents).toBe(0.5);
      expect(rule.N?.shareNamingModel).toBeNull();
    });
  });

  describe("the plan", () => {
    it("covers 6 tasks x 3 arms x 2 repeats with every arm first equally often", () => {
      const names = loadTasks().map((task) => task.name);
      expect(names).toHaveLength(6);
      const cells = plannedCells(names, 2);
      expect(cells).toHaveLength(36);
      expect(
        new Set(cells.map((c) => `${c.task}|${c.arm}|${c.repeat}`)).size,
      ).toBe(36);
      const firsts = cells
        .filter((_, index) => index % 3 === 0)
        .map((cell) => cell.arm);
      for (const arm of ["N", "R", "RD"]) {
        expect(firsts.filter((first) => first === arm)).toHaveLength(4);
      }
    });
  });

  describe("fixtures", () => {
    it("has a passing base, so a task failure comes from the task", () => {
      expect(testsPassIn(join(ROUTING_ROOT, "base"))).toBe(true);
    });

    it("gives test-graded tasks work to do", () => {
      for (const task of loadTasks()) {
        if (task.grader.kind !== "tests") continue;
        const project = join(workRoot, task.name);
        mkdirSync(project);
        prepareProject(project, task);
        expect(testsPassIn(project), task.name).toBe(false);
      }
    });

    it("points answer graders at functions that exist", () => {
      for (const { name, grader } of loadTasks()) {
        if (grader.kind !== "answer") continue;
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
