import { describe, expect, it, vi } from "vitest";

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
});
