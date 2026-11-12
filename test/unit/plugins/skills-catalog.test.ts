import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FIRST_PARTY_SKILLS } from "../../../scripts/skill-provenance.js";
import { expectSafeRouteHint } from "../route-hint.js";

vi.mock("../../../src/core/package-assets.js", () => ({
  resolveVendoredSkillPath: () => {
    throw new Error(
      "Unable to locate agemon's vendored assets/skills directory.",
    );
  },
}));

describe("SKILL_GROUPS", () => {
  it("loads without the vendored assets and resolves a vendored path only when read", async () => {
    const { findSkillGroup } = await import(
      "../../../src/plugins/skills/catalog.js"
    );
    const designSkill = findSkillGroup("design")?.skills[0];

    expect(designSkill?.skillName).toBe("agemon-design");
    expect(() => designSkill?.source).toThrow(
      "Unable to locate agemon's vendored assets/skills directory.",
    );
  });

  it("ships the unused-code check as a first-party code-quality skill that never installs Knip", async () => {
    const { findSkillGroup } = await import(
      "../../../src/plugins/skills/catalog.js"
    );
    const skillPath = "code-quality/agemon-unused-code-check";
    const skillText = readFileSync(
      `assets/skills/${skillPath}/SKILL.md`,
      "utf8",
    );

    expect(
      findSkillGroup("code-quality")?.skills.map((skill) => skill.skillName),
    ).toContain("agemon-unused-code-check");
    expect(FIRST_PARTY_SKILLS).toContain(skillPath);
    expect(skillText).toContain("npx --no-install knip");
    expect(skillText).not.toMatch(/npm (i|install) .*knip|npx knip(?! --no)/u);
  });

  it("gives every built-in skill a one-line route hint safe inside a Markdown table", async () => {
    const { MAX_ROUTE_HINT_LENGTH, SKILL_GROUPS } = await import(
      "../../../src/plugins/skills/catalog.js"
    );

    for (const skill of SKILL_GROUPS.flatMap((group) => group.skills)) {
      expectSafeRouteHint(skill.routeHint, MAX_ROUTE_HINT_LENGTH);
    }
  });
});
