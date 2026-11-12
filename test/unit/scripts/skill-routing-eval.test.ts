import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRunner } from "../../../scripts/design-eval/claude.js";
import {
  installArm,
  loadCases,
  runSkillRouting,
} from "../../../scripts/skill-routing-eval/run.js";
import {
  assertSkillToolWasUsed,
  classifyInvocations,
  type SkillRoutingRun,
  summarizeSkillRouting,
} from "../../../scripts/skill-routing-eval/score.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const SKILLS_ROOT = join(REPOSITORY_ROOT, "assets", "skills");
const EVALUATED = new Set([
  "agemon-root-cause",
  "agemon-design",
  "writing-guidelines",
]);

function run(overrides: Partial<SkillRoutingRun>): SkillRoutingRun {
  return {
    caseId: "case",
    arm: "N",
    outcome: "hit",
    invoked: [],
    foreign: [],
    skillCalls: 0,
    announcedSkillCount: 0,
    errored: false,
    ...overrides,
  };
}

function skillCallTranscript(skill: string): string {
  const events = [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Skill", input: { skill } }],
      },
    },
    { type: "result", subtype: "success", total_cost_usd: 0.2, num_turns: 2 },
  ];
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("classifyInvocations", () => {
  it("scores the expected skill as a hit", () => {
    expect(
      classifyInvocations(
        ["agemon-root-cause"],
        ["agemon-root-cause"],
        EVALUATED,
      ),
    ).toEqual({ outcome: "hit", foreign: [] });
  });

  it("sets a namespaced copy aside as foreign", () => {
    expect(
      classifyInvocations(
        ["anthropic-skills:agemon-root-cause"],
        ["agemon-root-cause"],
        EVALUATED,
      ),
    ).toEqual({
      outcome: "miss",
      foreign: ["anthropic-skills:agemon-root-cause"],
    });
  });

  it("scores another evaluated skill as the wrong skill", () => {
    expect(
      classifyInvocations(["agemon-design"], ["agemon-root-cause"], EVALUATED)
        .outcome,
    ).toBe("wrong-skill");
  });

  it("scores negative controls as false-trigger or quiet", () => {
    expect(
      classifyInvocations(["writing-guidelines"], [], EVALUATED).outcome,
    ).toBe("false-trigger");
    expect(classifyInvocations([], [], EVALUATED).outcome).toBe("quiet");
  });
});

describe("summarizeSkillRouting", () => {
  it("leaves errored runs out of the rates but counts them", () => {
    const summary = summarizeSkillRouting([
      run({ outcome: "hit" }),
      run({ outcome: "hit" }),
      run({ outcome: "miss" }),
      run({ outcome: "hit", errored: true }),
      run({ outcome: "quiet" }),
      run({ outcome: "false-trigger" }),
    ]);
    expect(summary.recall).toBeCloseTo(2 / 3);
    expect(summary.falseTriggerRate).toBe(0.5);
    expect(summary.runs).toBe(6);
  });
});

describe("assertSkillToolWasUsed", () => {
  it("throws when no run called the Skill tool", () => {
    const runs = [run({}), run({}), run({})];
    expect(() => assertSkillToolWasUsed(runs)).toThrow(
      /no Skill call in 3 runs/u,
    );
  });
});

describe("skill-routing harness", () => {
  let workRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "skill-routing-eval-test-"));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it("installs arm N with the rules block, every skill and no index", () => {
    installArm(workRoot, "N");
    const agents = readFileSync(join(workRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- agemon:start:agent-rules -->");
    expect(agents).not.toContain("<!-- agemon:start:capability-index -->");
    expect(
      existsSync(
        join(workRoot, ".claude", "skills", "agemon-root-cause", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("installs arm I with the capability index after the rules block", () => {
    installArm(workRoot, "I");
    const agents = readFileSync(join(workRoot, "AGENTS.md"), "utf8");
    const rulesEnd = agents.indexOf("<!-- agemon:end:agent-rules -->");
    const indexStart = agents.indexOf("<!-- agemon:start:capability-index -->");
    expect(rulesEnd).toBeGreaterThan(0);
    expect(indexStart).toBeGreaterThan(rulesEnd);
    expect(agents).toContain("<!-- agemon:end:capability-index -->");
    expect(agents).toContain(
      "| A bug, failing test or unexpected behavior, before proposing a fix | `agemon-root-cause` |",
    );
    expect(agents).toContain("| `agnix` |");
    expect(agents).toContain("`code-review-graph`");
  });

  it("loads a corpus whose expected skills all exist", () => {
    const cases = loadCases();
    const shippedSkills = new Set(
      readdirSync(SKILLS_ROOT).flatMap((group) =>
        readdirSync(join(SKILLS_ROOT, group)),
      ),
    );
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(
      cases
        .flatMap((entry) => entry.expected)
        .filter((name) => !shippedSkills.has(name)),
    ).toEqual([]);
    expect(
      cases.filter((entry) => entry.expected.length === 0).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("scores a run from the Skill calls in its transcript", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: skillCallTranscript("agemon-commit"),
      exitCode: 0,
    });
    const commitSplit = loadCases().filter(
      (entry) => entry.id === "commit-split",
    );
    const { runs } = await runSkillRouting({
      cases: commitSplit,
      repeats: 1,
      arm: "N",
      runner,
      workRoot,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("hit");
    expect(runs[0]?.skillCalls).toBe(1);
    expect(runs[0]?.errored).toBe(false);
  });
});
