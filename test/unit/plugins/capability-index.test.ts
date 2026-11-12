import { describe, expect, it } from "vitest";
import { upsertManagedMarkdownBlock } from "../../../src/patchers/markdown-block.js";
import {
  buildCapabilityIndexBlockBody,
  CAPABILITY_INDEX_BLOCK_ID,
  type IndexedSkill,
  MAX_INDEXED_SKILL_ROWS,
} from "../../../src/plugins/master-prompt/capability-index.js";

const ROOT_CAUSE: IndexedSkill = {
  skillName: "agemon-root-cause",
  routeHint:
    "A bug, failing test or unexpected behavior, before proposing a fix",
};
const COMMIT: IndexedSkill = {
  skillName: "agemon-commit",
  routeHint: "Writing a commit message or preparing a commit",
};
const AGNIX_TOOL = {
  routeHint: "Check agent config files for mistakes",
  indexCommand: "`agnix`",
};

function skillRows(body: string): string[] {
  const skillsSection = body.split("### Tools")[0] ?? "";
  return skillsSection
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| When"));
}

describe("buildCapabilityIndexBlockBody", () => {
  it("renders one row per skill in the given order", () => {
    const body = buildCapabilityIndexBlockBody(
      [ROOT_CAUSE, COMMIT],
      [AGNIX_TOOL],
    );

    expect(body).toBe(
      [
        "## Capability Index",
        "",
        "Installed by agemon in this repository. Before starting a task, find the row that matches it and load that skill by name. If no row matches, continue without one.",
        "",
        "### Skills",
        "",
        "| When the task is | Use |",
        "|---|---|",
        "| A bug, failing test or unexpected behavior, before proposing a fix | `agemon-root-cause` |",
        "| Writing a commit message or preparing a commit | `agemon-commit` |",
        "",
        "### Tools",
        "",
        "| Need | Command |",
        "|---|---|",
        "| Check agent config files for mistakes | `agnix` |",
      ].join("\n"),
    );
  });

  it("never copies a custom skill's description", () => {
    const body = buildCapabilityIndexBlockBody(
      [{ skillName: "evil", routeHint: null }],
      [],
    );

    expect(skillRows(body)).toEqual([
      "| Defined in this repository's agemon.toml | `evil`: read its SKILL.md description first |",
    ]);
  });

  it("collapses rows past the cap", () => {
    const skills = Array.from(
      { length: MAX_INDEXED_SKILL_ROWS + 5 },
      (_, i) => ({
        skillName: `skill-${i}`,
        routeHint: `Task ${i}`,
      }),
    );

    const rows = skillRows(buildCapabilityIndexBlockBody(skills, []));

    expect(rows).toHaveLength(MAX_INDEXED_SKILL_ROWS + 1);
    expect(rows.at(-2)).toBe(
      `| Task ${MAX_INDEXED_SKILL_ROWS - 1} | \`skill-${MAX_INDEXED_SKILL_ROWS - 1}\` |`,
    );
    expect(rows.at(-1)).toBe("| 5 more skills | see `.claude/skills/` |");
  });

  it("omits empty sections", () => {
    const toolsOnly = buildCapabilityIndexBlockBody([], [AGNIX_TOOL]);
    const skillsOnly = buildCapabilityIndexBlockBody([COMMIT], []);

    expect(toolsOnly).not.toContain("### Skills");
    expect(toolsOnly).toContain("### Tools");
    expect(skillsOnly).toContain("### Skills");
    expect(skillsOnly).not.toContain("### Tools");
    expect(skillsOnly.endsWith("\n")).toBe(false);
  });

  it("skips names that are not plain skill identifiers", () => {
    const body = buildCapabilityIndexBlockBody(
      [
        { skillName: "a|b", routeHint: "Pipe" },
        { skillName: "../x", routeHint: "Traversal" },
        COMMIT,
      ],
      [],
    );

    expect(skillRows(body)).toEqual([
      "| Writing a commit message or preparing a commit | `agemon-commit` |",
    ]);
  });

  it("produces balanced managed markers when upserted", () => {
    const { nextContent } = upsertManagedMarkdownBlock(
      "",
      CAPABILITY_INDEX_BLOCK_ID,
      buildCapabilityIndexBlockBody([COMMIT], [AGNIX_TOOL]),
    );

    for (const marker of [
      "<!-- agemon:start:capability-index -->",
      "<!-- agemon:end:capability-index -->",
    ]) {
      expect(nextContent.split(marker)).toHaveLength(2);
    }
  });
});
