import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteContentError } from "../../../scripts/site-content/error.js";
import { generateSiteContent } from "../../../scripts/site-content/generate.js";
import {
  collectCliHelp,
  createHelpRunner,
  type HelpRunner,
} from "../../../scripts/site-content/help.js";
import { checksumInstallScript } from "../../../scripts/site-content/install-script.js";
import {
  assertPublishable,
  extractSection,
  type LinkTargets,
  parseMarkdown,
  rewriteLinks,
} from "../../../scripts/site-content/markdown.js";
import { renderPage } from "../../../scripts/site-content/page.js";
import { parseNotice } from "../../../scripts/skill-provenance.js";
import {
  SKILL_GROUPS,
  type SkillGroup,
} from "../../../src/plugins/skills/catalog.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const SKILLS_ROOT = join(REPOSITORY_ROOT, "assets", "skills");
const REF = "0123456789abcdef0123456789abcdef01234567";

const FAKE_ROOT_HELP = [
  "Usage: agemon [options] [command]",
  "",
  "Commands:",
  "  inspect [options]   Read-only inventory",
  "                      + duplication report",
  "  nuke [options]      Reverse agemon-managed changes",
  "",
].join("\n");
const fakeHelp: HelpRunner = (commandArguments) =>
  commandArguments.length === 0
    ? FAKE_ROOT_HELP
    : `banner\nUsage: agemon ${commandArguments[0]} [options]\n`;

let websiteRoot: string;

beforeEach(() => {
  websiteRoot = mkdtempSync(join(tmpdir(), "agemon-site-content-"));
});

afterEach(() => {
  rmSync(websiteRoot, { recursive: true, force: true });
});

function generate(
  overrides: Partial<Parameters<typeof generateSiteContent>[0]> = {},
): void {
  generateSiteContent({
    repositoryRoot: REPOSITORY_ROOT,
    websiteRoot,
    skillGroups: SKILL_GROUPS,
    skillsRoot: SKILLS_ROOT,
    runHelp: fakeHelp,
    installScriptPath: join(REPOSITORY_ROOT, "install.sh"),
    repositoryRef: REF,
    ...overrides,
  });
}

function generatedPage(path: string): string {
  return readFileSync(join(websiteRoot, "src/content/docs", path), "utf8");
}

const targets: LinkTargets = {
  routeForFile: new Map([["SECURITY.md", "/project/security/"]]),
  routeForReadmeAnchor: new Map([
    ["install", "/start/getting-started/#install"],
  ]),
  repositoryRef: REF,
};

function rewrittenUrl(url: string, sourcePath = "docs/guide.md"): string {
  const root = parseMarkdown(`[label](${url})`);
  rewriteLinks(root.children, sourcePath, targets);
  return JSON.stringify(root).match(/"url":"([^"]*)"/u)?.[1] ?? "";
}

describe("skill library pages", () => {
  it("every catalog group has exactly one generated page and the index lists them all", () => {
    generate();
    const pages = readdirSync(join(websiteRoot, "src/content/docs/skills"));
    expect(pages.sort()).toEqual(
      ["index.md", ...SKILL_GROUPS.map((group) => `${group.id}.md`)].sort(),
    );
    const index = generatedPage("skills/index.md");
    for (const group of SKILL_GROUPS) {
      expect(index).toContain(`](/skills/${group.id}/)`);
    }
    expect(index.match(/\]\(\/skills\/[^)]+\/\)/gu)).toHaveLength(
      SKILL_GROUPS.length,
    );
  });

  it("shows source, commit and license from NOTICE.md, and first-party and pinned provenance", () => {
    generate();
    const geoNotice = parseNotice(
      readFileSync(join(SKILLS_ROOT, "geo-seo/geo/NOTICE.md"), "utf8"),
    ).notice;
    const geoPage = generatedPage("skills/geo-seo.md");
    expect(geoPage).toContain(`<${geoNotice?.source}>`);
    expect(geoPage).toContain(`\`${geoNotice?.commit.slice(0, 12)}\``);
    expect(generatedPage("skills/commit.md")).toMatch(
      /`agemon-commit`\s*\|\s*first-party \(agemon\)\s*\|\s*—\s*\|\s*MIT/u,
    );
    expect(generatedPage("skills/essentials.md")).toContain(
      "see the upstream repository",
    );
  });

  it("renders catalog text with |, < and backticks as text, not structure", () => {
    const hostile: SkillGroup = {
      id: "hostile",
      label: "Hostile `label`",
      description: 'a | b <script>alert(1)</script> `c`\n---\nhead: "x"',
      defaultSelected: false,
      skills: [],
    };
    generate({ skillGroups: [hostile] });
    const page = generatedPage("skills/hostile.md");
    const [, frontmatter, body] = page.split(/^---$/mu);
    expect(frontmatter.trim().split("\n")).toHaveLength(4);
    expect(frontmatter).not.toMatch(/^head:/mu);
    const reparsed = parseMarkdown(body);
    expect(() => assertPublishable(reparsed.children, "page")).not.toThrow();
    expect(JSON.stringify(reparsed)).toContain("<script>alert(1)</script>");
  });
});

describe("front matter", () => {
  it("keeps a value with a newline, ---, head: or ': ' as one scalar", () => {
    const page = renderPage({
      path: "x.md",
      title: 'T\n---\nhead: [{ tag: "script" }]',
      description: "a: b",
      sidebarOrder: 1,
      body: [],
    });
    const lines = page.split("\n");
    const frontmatterLines = lines.slice(1, lines.indexOf("---", 1));
    expect(frontmatterLines).toEqual([
      'title: "T\\n---\\nhead: [{ tag: \\"script\\" }]"',
      'description: "a: b"',
      "sidebar:",
      "  order: 1",
    ]);
  });
});

describe("imported markdown", () => {
  it("fails on raw HTML with the file name", () => {
    const root = parseMarkdown("# T\n\n<script>alert(1)</script>\n");
    expect(() => assertPublishable(root.children, "SECURITY.md")).toThrow(
      /SECURITY\.md:3: contains raw HTML/u,
    );
  });

  it("fails on images", () => {
    const root = parseMarkdown("![x](https://example.com/x.svg)\n");
    expect(() => assertPublishable(root.children, "README.md")).toThrow(
      /contains an image/u,
    );
  });

  it("fails on directive syntax in text but not in code", () => {
    expect(() =>
      assertPublishable(parseMarkdown(":::note\nhi\n:::\n").children, "a.md"),
    ).toThrow(/directive/u);
    expect(() =>
      assertPublishable(
        parseMarkdown("```\n:::note\n```\n\nuse `:abbr[x]` here\n").children,
        "a.md",
      ),
    ).not.toThrow();
  });

  it("rewrites relative links to site routes or GitHub at the given ref", () => {
    expect(rewrittenUrl("../SECURITY.md#scope")).toBe(
      "/project/security/#scope",
    );
    expect(rewrittenUrl("../README.md#install")).toBe(
      "/start/getting-started/#install",
    );
    expect(rewrittenUrl("../README.md#license")).toBe(
      `https://github.com/Korak-997/agemon/blob/${REF}/README.md#license`,
    );
    expect(rewrittenUrl("../src/cli/index.ts")).toBe(
      `https://github.com/Korak-997/agemon/blob/${REF}/src/cli/index.ts`,
    );
    expect(rewrittenUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(rewrittenUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.com",
    "//example.com/x",
    "../../outside.md",
  ])("refuses the link %s", (url) => {
    expect(() => rewrittenUrl(url)).toThrow(SiteContentError);
  });

  it("fails instead of producing an empty page when a README heading is missing", () => {
    expect(() =>
      extractSection(parseMarkdown("# Readme\n"), "Install", "README.md"),
    ).toThrow(/README\.md: has no heading "Install"/u);
  });
});

describe("commands page", () => {
  it("includes the root help and one section per command listed in it", () => {
    const help = collectCliHelp(
      createHelpRunner([
        "--import",
        import.meta.resolve("tsx"),
        join(REPOSITORY_ROOT, "src/cli/index.ts"),
      ]),
    );
    const listed = help.root
      .slice(help.root.indexOf("Commands:"))
      .split("\n")
      .filter((line) => /^ {2}[a-z]/u.test(line))
      .map((line) => line.trim().split(" ")[0]);
    expect(listed.length).toBeGreaterThan(0);
    expect(help.commands.map((command) => command.name)).toEqual(listed);
    for (const command of help.commands) {
      expect(command.help.startsWith(`Usage: agemon ${command.name}`)).toBe(
        true,
      );
    }
    expect(help.root).toContain("Exit codes:");
  });

  it("refuses an unexpected command name", () => {
    expect(() => collectCliHelp(() => "Commands:\n  $(evil)   x\n")).toThrow(
      /unexpected command name/u,
    );
  });
});

describe("install.sh checksum", () => {
  const script = Buffer.from("#!/bin/sh\necho hi\n");
  const sha256 = createHash("sha256").update(script).digest("hex");

  it("matches SHA256SUMS in a release build", () => {
    expect(
      checksumInstallScript(
        script,
        `${"0".repeat(64)}  agemon.tgz\n${sha256}  install.sh\n`,
      ),
    ).toEqual({ sha256, source: "release" });
  });

  it("fails when the file does not match SHA256SUMS", () => {
    expect(() =>
      checksumInstallScript(script, `${"0".repeat(64)}  install.sh\n`),
    ).toThrow(/does not match SHA256SUMS/u);
  });

  it("fails unless SHA256SUMS lists install.sh exactly once", () => {
    expect(() => checksumInstallScript(script, "")).toThrow(/exactly once/u);
    expect(() =>
      checksumInstallScript(
        script,
        `${sha256}  install.sh\n${sha256}  install.sh\n`,
      ),
    ).toThrow(/exactly once/u);
  });

  it("marks a build without SHA256SUMS as a working-tree build", () => {
    expect(checksumInstallScript(script)).toEqual({
      sha256,
      source: "working-tree",
    });
  });

  it("serves the checksummed bytes and records them in site-data.json", () => {
    generate();
    const served = readFileSync(join(websiteRoot, "public/install.sh"));
    expect(
      served.equals(readFileSync(join(REPOSITORY_ROOT, "install.sh"))),
    ).toBe(true);
    const siteData = JSON.parse(
      readFileSync(join(websiteRoot, "src/generated/site-data.json"), "utf8"),
    );
    expect(siteData.installSh).toEqual({
      sha256: createHash("sha256").update(served).digest("hex"),
      source: "working-tree",
    });
    expect(siteData.releaseTag).toBeNull();
  });
});

describe("parseNotice", () => {
  it("returns every field, or the fields that are not present exactly once", () => {
    const notice = [
      "- Source: https://github.com/example/skills",
      "- Path in source: skills/x",
      `- Commit: ${"a".repeat(40)}`,
      "- Retrieved: 2026-10-29",
      "- License: MIT — see LICENSE.",
    ].join("\n");
    expect(parseNotice(notice).notice).toEqual({
      source: "https://github.com/example/skills",
      pathInSource: "skills/x",
      commit: "a".repeat(40),
      retrieved: "2026-10-29",
      license: "MIT",
    });
    const incomplete = parseNotice(notice.replace(/- Commit:.*\n/u, ""));
    expect(incomplete.notice).toBeUndefined();
    expect(incomplete.fieldsNotExactlyOnce).toEqual([
      "- Commit: <40-character commit SHA>",
    ]);
  });
});
