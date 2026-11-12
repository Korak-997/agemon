import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NON_MARKDOWN_FILES } from "../../../scripts/lint-skills/rules.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";

const GROUP_FOLDER = "browser-testing";
const SKILL_NAME = "agemon-webapp-testing";

const PYTHON_FILES = [
  "examples/console_logging.py",
  "examples/element_discovery.py",
  "examples/static_html_automation.py",
  "scripts/with_server.py",
];

const LICENSE_FILE_NAME = "LICENSE";
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
      : [entryPath];
  });
}

describe("browser-testing skill group", () => {
  it("is optional and holds one skill", () => {
    const group = findSkillGroup("browser-testing");

    expect(group?.defaultSelected).toBe(false);
    expect(group?.skills.map((skill) => skill.skillName)).toEqual([SKILL_NAME]);
  });

  it("allow-lists exactly the four Python files", () => {
    const shippedNonMarkdownFiles = listFilesUnder(skillDirectory())
      .map((filePath) => relative(skillDirectory(), filePath))
      .filter(
        (relativePath) =>
          relativePath !== LICENSE_FILE_NAME &&
          !MARKDOWN_FILE_PATTERN.test(relativePath),
      )
      .sort();

    expect(shippedNonMarkdownFiles).toEqual(PYTHON_FILES);
    for (const pythonFile of PYTHON_FILES) {
      expect(NON_MARKDOWN_FILES).toContain(
        `${GROUP_FOLDER}/${SKILL_NAME}/${pythonFile}`,
      );
    }
  });

  it("drops upstream's license frontmatter key", () => {
    const frontmatter = frontmatterOf(readSkillText("SKILL.md"));

    expect(frontmatter).toMatch(new RegExp(`^name: ${SKILL_NAME}$`, "mu"));
    expect(frontmatter).not.toMatch(/^license:/mu);
  });

  it("states every modification, as Apache-2.0 requires", () => {
    const notice = readSkillText("NOTICE.md");

    expect(notice).toContain("- License: Apache-2.0");
    expect(notice).toContain("Renamed `LICENSE.txt` to `LICENSE`");
    expect(notice).toContain(
      "Renamed from `webapp-testing` to `agemon-webapp-testing`",
    );
    expect(notice).toContain("Removed the `license` frontmatter key");
  });

  it("names its prerequisite and its command execution in the group description", () => {
    const description = findSkillGroup("browser-testing")?.description;

    expect(description).toContain("Python Playwright");
    expect(description).toContain("permission prompts");
  });
});
