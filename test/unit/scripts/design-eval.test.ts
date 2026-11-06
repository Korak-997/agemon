import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActivationCase,
  type ActivationRun,
  planBatch,
  runActivation,
  scoreActivation,
  splitCases,
} from "../../../scripts/design-eval/activation.js";
import {
  ACTIVATION_TOOLS,
  activatedSkills,
  announcedSkills,
  assessRun,
  assessRunIn,
  BUILD_TOOLS,
  buildClaudeArgv,
  type ClaudeRunner,
  createResultsFile,
  DEFAULT_SKILL_REF,
  designSkillNames,
  installArm,
  newBatchId,
  parseArm,
  parseModel,
  redactHome,
  resultsPath,
  runUsage,
  sumUsage,
  transcriptsDirectory,
  WORKING_TREE_REF,
  writesOutsideProject,
} from "../../../scripts/design-eval/claude.js";
import {
  briefNames,
  builtWithoutQuestion,
  runOutputBuild,
} from "../../../scripts/design-eval/output.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const EVAL_ROOT = join(REPOSITORY_ROOT, "evals", "design");
const DESIGN_SKILL = "agemon-design";

const corpus = JSON.parse(
  readFileSync(join(EVAL_ROOT, "activation-cases.json"), "utf8"),
) as ActivationCase[];

function skillCallTranscript(skill: string): string {
  const message = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Skill", input: { skill } }],
    },
  };
  return `${JSON.stringify(message)}\n`;
}

function initTranscript(skills: string[]): string {
  return `${JSON.stringify({ type: "system", subtype: "init", model: "m", skills })}\n`;
}

function run(
  kind: ActivationCase["kind"],
  expected: ActivationCase["expected"],
  activated: boolean,
): ActivationRun {
  return { kind, expected, activated };
}

let workDirectory: string;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "agemon-design-eval-"));
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("activation corpus", () => {
  it("holds 13 cases that name no skill", () => {
    expect(corpus).toHaveLength(13);
    for (const { prompt } of corpus) {
      expect(prompt.toLowerCase()).not.toMatch(/agemon|skill|web-design/u);
    }
  });

  it("covers every kind, including the guidelines boundary", () => {
    const kinds = new Set(corpus.map((entry) => entry.kind));
    expect(kinds).toEqual(
      new Set(["clear", "small-edit", "near-miss", "guidelines-boundary"]),
    );
  });
});

describe("activation corpus tracks", () => {
  it("has a trigger case for each track of the skill", () => {
    const tracks = corpus
      .filter((entry) => entry.expected === "trigger")
      .map((entry) => entry.track);

    expect(new Set(tracks)).toEqual(
      new Set(["small-edit", "in-brand-feature", "new-surface", "review-only"]),
    );
  });
});

describe("splitCases", () => {
  it("is stable for a seed and splits 60/40", () => {
    const first = splitCases(corpus, 7);
    expect(splitCases(corpus, 7)).toEqual(first);
    expect(first.train).toHaveLength(8);
    expect(first.validation).toHaveLength(5);
  });

  it("partitions the corpus with no overlap", () => {
    const { train, validation } = splitCases(corpus, 7);
    const prompts = [...train, ...validation].map((entry) => entry.prompt);
    expect(prompts.sort()).toEqual(corpus.map((entry) => entry.prompt).sort());
  });

  it("changes the split for a different seed", () => {
    expect(splitCases(corpus, 1)).not.toEqual(splitCases(corpus, 2));
  });
});

function resultEvent(
  subtype: string,
  result = "",
  isError = subtype !== "success",
): string {
  return `${JSON.stringify({ type: "result", subtype, result, is_error: isError })}\n`;
}

function completedTranscript(
  skills: string[],
  announced: string[] = [],
): string {
  const calls = skills.map(skillCallTranscript).join("");
  return `${initTranscript(announced)}${calls}${resultEvent("success")}`;
}

const first = corpus[0] as ActivationCase;

describe("scoreActivation", () => {
  it("reports clear, small-edit and near-miss rates separately, with counts", () => {
    const score = scoreActivation([
      run("clear", "trigger", true),
      run("clear", "trigger", false),
      run("small-edit", "trigger", true),
      run("near-miss", "no-trigger", false),
      run("near-miss", "no-trigger", true),
    ]);
    expect(score.clear).toMatchObject({ correct: 1, total: 2, rate: 0.5 });
    expect(score["small-edit"]).toMatchObject({
      correct: 1,
      total: 1,
      rate: 1,
    });
    expect(score["near-miss"]).toMatchObject({
      correct: 1,
      total: 2,
      rate: 0.5,
    });
  });

  it("reports a rate of null where a kind has no runs", () => {
    expect(scoreActivation([])["guidelines-boundary"]).toEqual({
      correct: 0,
      total: 0,
      rate: null,
      errored: 0,
      contaminated: 0,
    });
  });

  it("excludes errored and contaminated runs from rates and counts them", () => {
    const score = scoreActivation([
      run("near-miss", "no-trigger", false),
      { ...run("near-miss", "no-trigger", false), errored: true },
      { ...run("near-miss", "no-trigger", false), contaminated: true },
    ]);
    expect(score["near-miss"]).toEqual({
      correct: 1,
      total: 1,
      rate: 1,
      errored: 1,
      contaminated: 1,
    });
  });
});

describe("detecting activation in a stream-json transcript", () => {
  it("sees a Skill tool call for the design skill", () => {
    expect(activatedSkills(skillCallTranscript(DESIGN_SKILL))).toEqual([
      DESIGN_SKILL,
    ]);
  });

  it("does not count a mere mention or a skill that never ran", () => {
    expect(activatedSkills(initTranscript([DESIGN_SKILL]))).toEqual([]);
    expect(announcedSkills(initTranscript([DESIGN_SKILL]))).toEqual([
      DESIGN_SKILL,
    ]);
  });

  it("ignores lines that are not JSON", () => {
    expect(activatedSkills("not json\n")).toEqual([]);
  });

  it("recognises namespaced and sibling design skill names", () => {
    expect(
      designSkillNames([
        "agemon-design",
        "anthropic-skills:agemon-design",
        "agemon-design-minimal",
        "agemon-designer",
        "agemon-commit",
      ]),
    ).toEqual([
      "agemon-design",
      "anthropic-skills:agemon-design",
      "agemon-design-minimal",
    ]);
  });
});

describe("assessRun", () => {
  it("treats success and hitting --max-turns as completed runs", () => {
    const ok = {
      transcript: `${initTranscript([])}${resultEvent("success")}`,
      exitCode: 0,
    };
    const maxTurns = {
      transcript: `${initTranscript([])}${resultEvent("error_max_turns")}`,
      exitCode: 1,
    };
    expect(assessRun(ok).status).toBe("ok");
    expect(assessRun(maxTurns).status).toBe("ok");
  });

  it("marks timeouts, buffer overflows, empty transcripts and failed results as errored", () => {
    const failed = {
      transcript: resultEvent("error_during_execution"),
      exitCode: 1,
    };
    expect(assessRun({ ...failed, failure: "timeout" })).toMatchObject({
      status: "errored",
      reason: "timeout",
    });
    expect(assessRun({ ...failed, failure: "buffer-overflow" }).status).toBe(
      "errored",
    );
    expect(assessRun({ transcript: "  \n", exitCode: 0 })).toMatchObject({
      status: "errored",
      reason: "empty-transcript",
    });
    expect(
      assessRun({ transcript: initTranscript([]), exitCode: 0 }).status,
    ).toBe("errored");
    expect(assessRun(failed).status).toBe("errored");
  });

  it("treats error_max_turns with is_error true as a completed run", () => {
    const run = {
      transcript: resultEvent("error_max_turns", "", true),
      exitCode: 1,
    };
    expect(assessRun(run).status).toBe("ok");
  });

  it("marks a success result with is_error true as errored, or fatal on a usage limit", () => {
    const other = {
      transcript: resultEvent("success", "something broke", true),
      exitCode: 1,
    };
    const limit = {
      transcript: resultEvent("success", "Usage limit reached", true),
      exitCode: 1,
    };
    expect(assessRun(other).status).toBe("errored");
    expect(assessRun(limit).status).toBe("fatal");
  });

  it("marks usage-limit and auth failures as fatal", () => {
    const limit = {
      transcript: resultEvent("error_during_execution", "Usage limit reached"),
      exitCode: 1,
    };
    const auth = {
      transcript: "",
      exitCode: 1,
      stderr: "Not logged in. Please run /login",
    };
    expect(assessRun(limit).status).toBe("fatal");
    expect(assessRun(auth).status).toBe("fatal");
  });
});

describe("headless build outcome", () => {
  function transcriptOf(writes: string[], finalText: string): string {
    const write = writes.map((file_path) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Write", input: { file_path } }],
        },
      }),
    );
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      result: finalText,
    });
    return [...write, result].join("\n");
  }

  it("counts a run that wrote files and did not end at a question", () => {
    expect(
      builtWithoutQuestion(transcriptOf(["/p/index.html"], "Built it.")),
    ).toBe(true);
  });

  it("fails a run that wrote only design state", () => {
    expect(
      builtWithoutQuestion(transcriptOf(["/p/.design/brief.md"], "Done.")),
    ).toBe(false);
  });

  it("fails a run that wrote nothing", () => {
    expect(builtWithoutQuestion(transcriptOf([], "All set."))).toBe(false);
  });

  it("fails a run that ended at a question", () => {
    expect(
      builtWithoutQuestion(
        transcriptOf(["/p/index.html"], "Built it. Which accent do you want?"),
      ),
    ).toBe(false);
  });
});

describe("installArm", () => {
  it("installs the working tree's skills when asked, without reading git", () => {
    installArm(workDirectory, "B", WORKING_TREE_REF);

    const installed = readdirSync(join(workDirectory, ".claude", "skills"));
    expect(installed).toContain(DESIGN_SKILL);
    expect(installed).not.toContain("agemon-design-minimal");
    expect(
      readFileSync(
        join(workDirectory, ".claude/skills", DESIGN_SKILL, "SKILL.md"),
        "utf8",
      ),
    ).toContain("## Tracks");
  });

  it("arm B installs the design skills plus a realistic companion subset", () => {
    installArm(workDirectory, "B");
    const installed = readdirSync(join(workDirectory, ".claude", "skills"));
    expect(installed).toContain(DESIGN_SKILL);
    expect(installed).toContain("agemon-commit");
    expect(installed.length).toBeLessThan(15);
  });

  it("arm A installs the same companions without any design skill", () => {
    installArm(workDirectory, "A");
    const installed = readdirSync(join(workDirectory, ".claude", "skills"));
    expect(installed).toContain("agemon-commit");
    expect(installed.some((name) => name.startsWith(DESIGN_SKILL))).toBe(false);
  });

  it("installs the skill as it exists at the ref, not the working tree", () => {
    installArm(workDirectory, "B", "HEAD");
    const installed = readFileSync(
      join(workDirectory, ".claude", "skills", DESIGN_SKILL, "SKILL.md"),
    );
    const atRef = execFileSync(
      "git",
      ["show", `HEAD:assets/skills/design/${DESIGN_SKILL}/SKILL.md`],
      { cwd: REPOSITORY_ROOT },
    );
    expect(installed.equals(atRef)).toBe(true);
  });

  it("installs the Essentials skills in both arms so the baseline has competing skills", () => {
    for (const arm of ["A", "B"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "agemon-design-eval-ess-"));
      try {
        installArm(directory, arm, "HEAD");
        const installed = readdirSync(join(directory, ".claude", "skills"));
        expect(installed).toContain("web-design-guidelines");
        expect(installed).toContain("writing-guidelines");
        expect(installed).not.toContain("NOTICE.md");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("pins the default skill ref to a full commit hash", () => {
    expect(DEFAULT_SKILL_REF).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("rejects an unknown ref and an option-like ref", () => {
    expect(() => installArm(workDirectory, "B", "no-such-ref-xyz")).toThrow();
    expect(() => installArm(workDirectory, "B", "--output=x")).toThrow(
      /git ref/u,
    );
  });
});

describe("option parsing", () => {
  it("requires arm A or B", () => {
    expect(parseArm("A")).toBe("A");
    expect(() => parseArm(undefined)).toThrow(/--arm/u);
    expect(() => parseArm("C")).toThrow(/--arm/u);
  });

  it("rejects an odd-looking model", () => {
    expect(parseModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(() => parseModel("x; rm -rf /")).toThrow(/--model/u);
  });
});

describe("planBatch", () => {
  it("caps a batch at 6 runs and requires a limit", () => {
    expect(
      planBatch(corpus, { offset: 0, limit: 3, runsPerCase: 2 }),
    ).toHaveLength(3);
    expect(() =>
      planBatch(corpus, { offset: 0, limit: 4, runsPerCase: 2 }),
    ).toThrow(/cap/u);
    expect(() =>
      planBatch(corpus, { offset: 0, limit: Number.NaN, runsPerCase: 2 }),
    ).toThrow(/--limit/u);
  });

  it("walks every case across offsets", () => {
    const seen = [0, 3, 6, 9, 12].flatMap((offset) =>
      planBatch(corpus, { offset, limit: 3, runsPerCase: 2 }),
    );
    expect(seen).toEqual(corpus);
  });
});

describe("result paths", () => {
  it("includes the arm and a unique batch id, and never overwrites", () => {
    const first = resultsPath("smoke", "A", "20261105120000-aaaaaa");
    const second = resultsPath("smoke", "A", "20261105120000-bbbbbb");
    const otherArm = resultsPath("smoke", "B", "20261105120000-aaaaaa");
    expect(new Set([first, second, otherArm]).size).toBe(3);
    expect(first).toContain("arm-A");
    expect(first).toContain("2026-11-05");
    expect(newBatchId()).not.toEqual(newBatchId());
    const target = join(workDirectory, "r.json");
    const header = {
      model: "m",
      effort: "e",
      agemonCommit: "c",
      arm: "A" as const,
      skillRef: "r",
      isolationNote: "n",
      cases: [],
    };
    createResultsFile(target, header);
    expect(() => createResultsFile(target, header)).toThrow(/EEXIST/u);
  });

  it("keeps transcripts under a transcripts directory that is git-ignored", () => {
    const directory = transcriptsDirectory(
      resultsPath("smoke", "B", "20261105120000-aaaaaa"),
    );
    expect(directory).toMatch(/results\/[^/]+\/transcripts$/u);
    const ignored = execFileSync(
      "git",
      ["check-ignore", "-q", join(directory, "0.jsonl")],
      {
        cwd: REPOSITORY_ROOT,
      },
    );
    expect(ignored).toBeDefined();
  });

  it("redacts the home directory", () => {
    expect(redactHome(join(homedir(), "x", "y"))).toBe(join("~", "x", "y"));
  });
});

describe("runActivation", () => {
  const baseOptions = () => ({
    cases: corpus.slice(0, 3),
    runsPerCase: 2,
    arm: "B" as const,
    workRoot: workDirectory,
  });

  it("runs each case the requested number of times and cleans up its temp directories", async () => {
    const seenPrompts: string[] = [];
    const runner: ClaudeRunner = async ({ prompt }) => {
      seenPrompts.push(prompt);
      return { transcript: completedTranscript([DESIGN_SKILL]), exitCode: 0 };
    };
    const result = await runActivation({ ...baseOptions(), runner });
    expect(seenPrompts).toHaveLength(6);
    expect(result.runs.every((entry) => entry.activated)).toBe(true);
    expect(readdirSync(workDirectory)).toEqual([]);
  });

  it("scores a crashed run as errored, not as did-not-trigger", async () => {
    const runner: ClaudeRunner = async () => ({ transcript: "", exitCode: 1 });
    const { runs } = await runActivation({
      ...baseOptions(),
      cases: [first],
      runsPerCase: 1,
      runner,
    });
    expect(runs[0]).toMatchObject({ errored: true, activated: false });
    expect(scoreActivation(runs).clear).toMatchObject({
      total: 0,
      rate: null,
      errored: 1,
    });
  });

  it("aborts the batch on a success result that carries a usage-limit error", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      return {
        transcript: resultEvent("success", "Usage limit reached", true),
        exitCode: 1,
      };
    };
    const result = await runActivation({ ...baseOptions(), runner });
    expect(calls).toBe(1);
    expect(result.aborted).toMatch(/usage-limit-or-auth/u);
  });

  it("scores a success result with is_error true as errored, not as did-not-trigger", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: resultEvent("success", "something broke", true),
      exitCode: 1,
    });
    const { runs } = await runActivation({
      ...baseOptions(),
      cases: [first],
      runsPerCase: 1,
      runner,
    });
    expect(runs[0]).toMatchObject({ errored: true });
    expect(scoreActivation(runs).clear).toMatchObject({
      total: 0,
      rate: null,
      errored: 1,
    });
  });

  it("uses the Skill calls of a run that hit --max-turns", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: `${completedTranscript([DESIGN_SKILL]).replace('"success"', '"error_max_turns"')}`,
      exitCode: 1,
    });
    const { runs } = await runActivation({
      ...baseOptions(),
      cases: [first],
      runsPerCase: 1,
      runner,
    });
    expect(runs[0]).toMatchObject({ errored: false, activated: true });
  });

  it("aborts the batch on a usage-limit error and keeps what ran", async () => {
    let calls = 0;
    const saved: number[] = [];
    const runner: ClaudeRunner = async () => {
      calls += 1;
      return calls === 1
        ? { transcript: completedTranscript([DESIGN_SKILL]), exitCode: 0 }
        : {
            transcript: resultEvent(
              "error_during_execution",
              "Usage limit reached",
            ),
            exitCode: 1,
          };
    };
    const result = await runActivation({
      ...baseOptions(),
      runner,
      save: ({ runs }) => saved.push(runs.length),
    });
    expect(calls).toBe(2);
    expect(result.runs).toHaveLength(2);
    expect(result.aborted).toMatch(/usage-limit-or-auth/u);
    expect(saved.length).toBeGreaterThanOrEqual(2);
  });

  it("counts only the project-level skill in arm B and flags a namespaced call", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: completedTranscript(["anthropic-skills:agemon-design"]),
      exitCode: 0,
    });
    const { runs } = await runActivation({
      ...baseOptions(),
      cases: [first],
      runsPerCase: 1,
      runner,
      allowContaminated: true,
    });
    expect(runs[0]).toMatchObject({
      activated: false,
      namespacedCall: true,
      invokedDesignSkills: ["anthropic-skills:agemon-design"],
    });
  });

  it("aborts after the first run when a non-project design skill is listed", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      return {
        transcript: completedTranscript([], ["anthropic-skills:agemon-design"]),
        exitCode: 0,
      };
    };
    const result = await runActivation({ ...baseOptions(), runner });
    expect(calls).toBe(1);
    expect(result.aborted).toMatch(/contaminated/u);
  });

  it("with --allow-contaminated labels every result contaminated", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      const announced = calls === 1 ? ["anthropic-skills:agemon-design"] : [];
      return { transcript: completedTranscript([], announced), exitCode: 0 };
    };
    const result = await runActivation({
      ...baseOptions(),
      runner,
      allowContaminated: true,
    });
    expect(result.runs).toHaveLength(6);
    expect(result.runs.every((entry) => entry.contaminated)).toBe(true);
  });

  it("flags a design skill listed in arm A as contamination", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: completedTranscript([], [DESIGN_SKILL]),
      exitCode: 0,
    });
    const result = await runActivation({
      ...baseOptions(),
      arm: "A",
      cases: [first],
      runsPerCase: 1,
      runner,
    });
    expect(result.runs[0]?.contaminated).toBe(true);
  });

  it("writes one transcript per run without overwriting and records relative paths", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: completedTranscript([]),
      exitCode: 0,
    });
    const transcriptDirectory = join(workDirectory, "t", "transcripts");
    const { runs } = await runActivation({
      ...baseOptions(),
      runner,
      transcriptDirectory,
    });
    expect(readdirSync(transcriptDirectory)).toHaveLength(6);
    expect(new Set(runs.map((entry) => entry.transcriptPath)).size).toBe(6);
    expect(JSON.stringify(runs)).not.toContain(homedir());
  });
});

describe("runOutputBuild", () => {
  const brief = briefNames()[0] as string;

  it("runs exactly one build for the named brief and records transcript path and metadata", async () => {
    const requests: { prompt: string; maxBudgetUsd?: number }[] = [];
    const runner: ClaudeRunner = async (request) => {
      requests.push(request);
      expect(existsSync(request.cwd)).toBe(true);
      return {
        transcript: `${initTranscript([])}${resultEvent("success")}`,
        exitCode: 0,
      };
    };
    const result = await runOutputBuild({
      arm: "A",
      brief,
      runner,
      workRoot: workDirectory,
      transcriptDirectory: join(workDirectory, "transcripts"),
      maxBudgetUsd: 2,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.maxBudgetUsd).toBe(2);
    expect(result.case).toMatchObject({
      brief,
      exitCode: 0,
      status: "ok",
      contaminated: false,
    });
    expect(
      existsSync(join(workDirectory, "transcripts", `${brief}.jsonl`)),
    ).toBe(true);
    expect(JSON.stringify(result.case)).not.toMatch(/session/u);
  });

  it("rejects an unknown brief before running anything", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      return { transcript: "", exitCode: 0 };
    };
    await expect(
      runOutputBuild({
        arm: "A",
        brief: "nope",
        runner,
        workRoot: workDirectory,
        transcriptDirectory: join(workDirectory, "t"),
      }),
    ).rejects.toThrow(/unknown brief/u);
    expect(calls).toBe(0);
  });
});

function writeCall(tool: string, filePath: string): string {
  const message = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: tool, input: { file_path: filePath } },
      ],
    },
  };
  return `${JSON.stringify(message)}\n`;
}

describe("tool restriction", () => {
  const request = {
    cwd: "/x",
    prompt: "p",
    maxTurns: 4,
    permissionMode: "plan" as const,
  };

  it("passes --tools explicitly, with no Bash, Artifact, web or MCP tools", () => {
    for (const tools of [ACTIVATION_TOOLS, BUILD_TOOLS]) {
      const argv = buildClaudeArgv({ ...request, tools });
      expect(argv[argv.indexOf("--tools") + 1]).toBe(tools);
      expect(tools.split(",")).not.toEqual(
        expect.arrayContaining(["Bash", "Artifact", "ToolSearch", "WebFetch"]),
      );
      expect(argv).toContain("--strict-mcp-config");
      expect(argv[argv.indexOf("--disallowed-tools") + 1]).toMatch(/Artifact/u);
    }
    expect(ACTIVATION_TOOLS).toBe("Skill,Read,Glob,Grep");
    expect(BUILD_TOOLS).toBe("Skill,Read,Glob,Grep,Write,Edit");
  });

  it("hands the matching tool list to the runner", async () => {
    const seen: string[] = [];
    const runner: ClaudeRunner = async ({ tools }) => {
      seen.push(tools);
      return { transcript: completedTranscript([]), exitCode: 0 };
    };
    await runActivation({
      cases: [first],
      runsPerCase: 1,
      arm: "B",
      runner,
      workRoot: workDirectory,
    });
    await runOutputBuild({
      arm: "A",
      brief: briefNames()[0] as string,
      runner,
      workRoot: workDirectory,
      transcriptDirectory: join(workDirectory, "t"),
    });
    expect(seen).toEqual([ACTIVATION_TOOLS, BUILD_TOOLS]);
  });
});

describe("writes outside the project", () => {
  it("flags Write and Edit calls whose path leaves the project directory", () => {
    const project = "/tmp/proj";
    const transcript = [
      writeCall("Write", "/tmp/proj/src/a.css"),
      writeCall("Edit", "src/b.css"),
      writeCall("Write", "/home/someone/.claude/plans/plan.md"),
      writeCall("Edit", "../escape.txt"),
    ].join("");
    expect(writesOutsideProject(transcript, project)).toEqual([
      "/home/someone/.claude/plans/plan.md",
      "../escape.txt",
    ]);
  });

  it("treats a sibling sharing the project path prefix as outside", () => {
    const evilTarget = "/tmp/abc-evil/x";
    expect(
      writesOutsideProject(writeCall("Write", evilTarget), "/tmp/abc"),
    ).toEqual([evilTarget]);
  });

  it("treats a file whose name starts with two dots as inside", () => {
    const transcript = [
      writeCall("Write", "..foo"),
      writeCall("Write", "/tmp/proj/..foo"),
    ].join("");
    expect(writesOutsideProject(transcript, "/tmp/proj")).toEqual([]);
  });

  it("treats a parent-relative path as outside", () => {
    expect(
      writesOutsideProject(writeCall("Edit", "../x"), "/tmp/proj"),
    ).toEqual(["../x"]);
  });

  it("accepts the real path of a symlinked project and rejects its sibling", () => {
    const realProject = join(workDirectory, "real-project");
    const symlinkedProject = join(workDirectory, "symlinked-project");
    mkdirSync(realProject);
    symlinkSync(realProject, symlinkedProject);
    const insideTarget = join(realpathSync(realProject), "src", "a.css");
    const siblingTarget = `${realpathSync(realProject)}-evil/a.css`;
    const transcript = [
      writeCall("Write", insideTarget),
      writeCall("Write", siblingTarget),
    ].join("");
    expect(writesOutsideProject(transcript, symlinkedProject)).toEqual([
      siblingTarget,
    ]);
  });

  it("marks the run errored and aborts the batch", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      return {
        transcript: `${writeCall("Write", "/home/someone/.claude/plans/p.md")}${resultEvent("success")}`,
        exitCode: 0,
      };
    };
    const result = await runActivation({
      cases: corpus.slice(0, 3),
      runsPerCase: 2,
      arm: "B",
      runner,
      workRoot: workDirectory,
    });
    expect(calls).toBe(1);
    expect(result.runs[0]).toMatchObject({
      errored: true,
      errorReason: "wrote-outside-project",
    });
    expect(result.aborted).toBe("wrote-outside-project");
    expect(
      assessRunIn(
        { transcript: writeCall("Write", "/tmp/proj/ok.txt"), exitCode: 0 },
        "/tmp/proj",
      ).reason,
    ).not.toBe("wrote-outside-project");
  });
});

describe("usage reporting", () => {
  const usageResult = (cost: number, turns: number) =>
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, num_turns: turns })}\n`;

  it("reads cost and turns from the result event and sums them", () => {
    expect(runUsage(usageResult(0.3, 2))).toEqual({
      costUsd: 0.3,
      numTurns: 2,
    });
    expect(runUsage("")).toEqual({ costUsd: undefined, numTurns: undefined });
    expect(
      sumUsage([
        { costUsd: 0.3, numTurns: 2 },
        { costUsd: 0.2, numTurns: 3 },
        {},
      ]),
    ).toEqual({ totalCostUsd: 0.5, totalTurns: 5 });
  });

  it("records usage and the announced skill count on every run", async () => {
    const runner: ClaudeRunner = async () => ({
      transcript: `${initTranscript(["a", "b", "c"])}${usageResult(0.25, 3)}`,
      exitCode: 0,
    });
    const { runs } = await runActivation({
      cases: [first],
      runsPerCase: 2,
      arm: "B",
      runner,
      workRoot: workDirectory,
    });
    expect(runs[0]).toMatchObject({
      costUsd: 0.25,
      numTurns: 3,
      announcedSkillCount: 3,
    });
    expect(sumUsage(runs).totalCostUsd).toBeCloseTo(0.5);
  });
});
