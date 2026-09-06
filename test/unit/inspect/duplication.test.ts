import { describe, expect, it } from "vitest";
import { detectDuplication } from "../../../src/inspect/duplication.js";

const CANONICAL_RULES = [
  "# AI Agent Rules",
  "",
  "Always discover existing tools before writing new code.",
  "Keep every change surgical and scoped to the request at hand.",
  "Preserve user-authored content outside agemon-managed files.",
  "Record out-of-scope findings in improvements.md instead of fixing them.",
].join("\n");

describe("detectDuplication", () => {
  it("reports two near-identical rule files as overlapping", () => {
    const report = detectDuplication([
      { path: "AGENTS.md", contents: CANONICAL_RULES },
      {
        path: "CLAUDE.md",
        contents: `${CANONICAL_RULES}\n\nExtra Claude note.\n`,
      },
    ]);

    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0].left).toBe("AGENTS.md");
    expect(report.overlaps[0].right).toBe("CLAUDE.md");
    expect(report.overlaps[0].similarity).toBeGreaterThanOrEqual(0.5);
  });

  it("does not flag a short pointer file against the canonical rules", () => {
    const pointer = [
      "<!-- AI agent rules pointer -->",
      "# AI Agent Rules",
      "",
      "The canonical rules for this repo live in AGENTS.md — read that file in full.",
    ].join("\n");

    const report = detectDuplication([
      { path: "AGENTS.md", contents: CANONICAL_RULES },
      { path: "CLAUDE.md", contents: pointer },
    ]);

    expect(report.overlaps).toEqual([]);
  });

  it("does not flag unrelated rule files", () => {
    const report = detectDuplication([
      { path: "AGENTS.md", contents: CANONICAL_RULES },
      {
        path: "GEMINI.md",
        contents:
          "# Gemini project context\n\nThis service exposes a GraphQL gateway.\nDeploys run through the staging pipeline on merge.\n",
      },
      { path: ".cursorrules", contents: null },
    ]);

    expect(report.overlaps).toEqual([]);
  });

  it("does not flag two agemon pointer files against each other", () => {
    const pointer = (tool: string, name: string) =>
      [
        "<!-- AI agent rules pointer -->",
        "# AI Agent Rules",
        "",
        "The canonical rules for this repo live in AGENTS.md — read that file in full before",
        `making any changes here. This file exists only because ${tool} looks for \`${name}\` specifically; it intentionally does not restate the rules.`,
        "",
      ].join("\n");

    for (const scope of ["all", "involving-canonical"] as const) {
      const report = detectDuplication(
        [
          { path: "CLAUDE.md", contents: pointer("Claude Code", "CLAUDE.md") },
          { path: "GEMINI.md", contents: pointer("Gemini CLI", "GEMINI.md") },
          { path: ".cursorrules", contents: pointer("Cursor", ".cursorrules") },
        ],
        { report: scope },
      );
      expect(report.overlaps).toEqual([]);
    }
  });

  it("keeps a canonical-vs-rule-file overlap and annotates the roles", () => {
    const report = detectDuplication([
      { path: "AGENTS.md", contents: CANONICAL_RULES },
      {
        path: "CLAUDE.md",
        contents: `${CANONICAL_RULES}\n\nExtra Claude note.\n`,
      },
    ]);

    expect(report.overlaps).toHaveLength(1);
    const [overlap] = report.overlaps;
    expect(overlap.leftRole).toBe("canonical");
    expect(overlap.rightRole).toBe("unknown");
    expect(overlap.bothRuleBearing).toBe(true);
  });

  it("hides a rule-file-vs-rule-file overlap from the default report but not from 'all'", () => {
    const files = [
      { path: "GEMINI.md", contents: `${CANONICAL_RULES}\n\nGemini note.\n` },
      {
        path: ".cursorrules",
        contents: `${CANONICAL_RULES}\n\nCursor note.\n`,
      },
    ];

    expect(detectDuplication(files).overlaps).toEqual([]);
    expect(detectDuplication(files, { report: "all" }).overlaps).toHaveLength(
      1,
    );
  });
});
