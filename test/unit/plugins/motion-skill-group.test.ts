import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";

const GROUP_FOLDER = "motion";
const SKILL_NAME = "agemon-motion-design";
const UPSTREAM_MARKDOWN_FILE_COUNT = 17;
const AGEMON_FILES = ["LICENSE", "NOTICE.md"];
const MARKDOWN_FILE_PATTERN = /\.md$/u;

function skillDirectory(): string {
  return resolveVendoredSkillPath(GROUP_FOLDER, SKILL_NAME);
}

function readSkillText(fileName: string): string {
  return readFileSync(join(skillDirectory(), fileName), "utf8");
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
      : [entryName];
  });
}

describe("motion skill group", () => {
  it("is optional and holds one skill", () => {
    const group = findSkillGroup("motion");

    expect(group?.defaultSelected).toBe(false);
    expect(group?.skills.map((skill) => skill.skillName)).toEqual([SKILL_NAME]);
  });

  it("ships the 17 upstream Markdown files and nothing else but its notice and license", () => {
    const shippedFileNames = listFilesUnder(skillDirectory());
    const upstreamFileNames = shippedFileNames.filter(
      (fileName) => !AGEMON_FILES.includes(fileName),
    );

    expect(upstreamFileNames).toHaveLength(UPSTREAM_MARKDOWN_FILE_COUNT);
    expect(
      upstreamFileNames.every((fileName) =>
        MARKDOWN_FILE_PATTERN.test(fileName),
      ),
    ).toBe(true);
    expect(shippedFileNames).toEqual(expect.arrayContaining(AGEMON_FILES));
  });

  it("drops upstream's license and metadata keys and lifts author and version", () => {
    const frontmatter = frontmatterOf(readSkillText("SKILL.md"));

    expect(frontmatter).toMatch(new RegExp(`^name: ${SKILL_NAME}$`, "mu"));
    expect(frontmatter).not.toMatch(/^(license|metadata):/mu);
    expect(frontmatter).toMatch(/^author: LottieFiles$/mu);
    expect(frontmatter).toMatch(/^version: "1\.0\.0"$/mu);
  });

  it("states every modification in its notice", () => {
    const notice = readSkillText("NOTICE.md");

    expect(notice).toContain(
      "- Source: https://github.com/LottieFiles/motion-design-skill",
    );
    expect(notice).toContain(
      "Renamed from `motion-design` to `agemon-motion-design`",
    );
    expect(notice).toContain("Removed the `license` frontmatter key");
  });
});
