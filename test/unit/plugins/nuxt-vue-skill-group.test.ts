import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNotice } from "../../../scripts/skill-provenance.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";

const KEPT_SKILLS = [
  "agemon-vue",
  "agemon-nuxt",
  "agemon-nitro",
  "agemon-pinia",
  "agemon-vite",
  "agemon-vitest",
  "agemon-unocss",
];

const ANTFU_SKILLS_COMMIT = "d524ed287eef22757297827ce42e3cad88abd20c";
const ANTFU_SKILLS_SOURCE = "https://github.com/antfu/skills";

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|svg|webp)$/iu;

function skillDirectory(skillName: string): string {
  return resolveVendoredSkillPath("nuxt-vue", skillName);
}

function groupDirectory(): string {
  return join(skillDirectory("agemon-vue"), "..");
}

function readSkillText(skillName: string, fileName: string): string {
  return readFileSync(join(skillDirectory(skillName), fileName), "utf8");
}

function frontmatterOf(skillMarkdown: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(skillMarkdown);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  return match[1];
}

function listFilesUnder(directoryPath: string): string[] {
  return readdirSync(directoryPath).flatMap((entryName) => {
    const entryPath = join(directoryPath, entryName);
    return statSync(entryPath).isDirectory()
      ? listFilesUnder(entryPath)
      : [entryPath];
  });
}

describe("nuxt-vue skill group", () => {
  it("is optional and lists the kept skills", () => {
    const group = findSkillGroup("nuxt-vue");

    expect(group?.defaultSelected).toBe(false);
    expect(group?.skills.map((skill) => skill.skillName)).toEqual(KEPT_SKILLS);
  });

  it("vendors exactly the kept skill directories", () => {
    expect(readdirSync(groupDirectory()).sort()).toEqual(
      [...KEPT_SKILLS].sort(),
    );
  });

  it("names each skill after its folder and carries no metadata key", () => {
    for (const skillName of KEPT_SKILLS) {
      const frontmatter = frontmatterOf(readSkillText(skillName, "SKILL.md"));

      expect(frontmatter).toMatch(new RegExp(`^name: ${skillName}$`, "mu"));
      expect(frontmatter).not.toMatch(/^metadata:/mu);
      expect(frontmatter).not.toMatch(/^license:/mu);
    }
  });

  it("pins every NOTICE to one antfu commit", () => {
    for (const skillName of KEPT_SKILLS) {
      const { notice } = parseNotice(readSkillText(skillName, "NOTICE.md"));

      expect(notice?.commit, skillName).toBe(ANTFU_SKILLS_COMMIT);
      expect(notice?.source, skillName).toBe(ANTFU_SKILLS_SOURCE);
    }
  });

  it("credits the CC BY 4.0 Vue documentation", () => {
    const notice = readSkillText("agemon-vue", "NOTICE.md");
    const license = readSkillText("agemon-vue", "LICENSE");

    expect(notice).toContain("CC-BY-4.0");
    expect(notice).toContain("Vue documentation contributors");
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(license).toContain("Attribution 4.0 International");
  });

  it("ships no image files", () => {
    expect(
      listFilesUnder(groupDirectory()).filter((filePath) =>
        IMAGE_FILE_PATTERN.test(filePath),
      ),
    ).toEqual([]);
  });

  it("warns that the docs track a specific upstream version", () => {
    expect(findSkillGroup("nuxt-vue")?.description).toContain(
      "check your project's versions",
    );
  });
});
