import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
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
  headingSlugs,
  type LinkTargets,
  parseMarkdown,
  rewriteLinks,
} from "../../../scripts/site-content/markdown.js";
import { renderPage } from "../../../scripts/site-content/page.js";
import { parseNotice } from "../../../scripts/skill-provenance.js";
import {
  SKILL_GROUPS,
  type SkillBundleEntry,
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

const SAFETY_POST_PATH = "src/content/docs/posts/safety-model.mdx";
const RECORDED_LEDGER_PATH = "src/data/recorded-ledger.json";

interface FixtureEntry {
  plugin: string;
  type: string;
  target: string;
  preExisting?: boolean;
  ownershipMode?: string | null;
  agemonVersion?: string | null;
}

function ledgerEntry(entry: FixtureEntry, index: number) {
  return {
    id: `entry-${index}`,
    plugin: entry.plugin,
    type: entry.type,
    target: entry.target,
    preExisting: entry.preExisting ?? false,
    createdAt: "2026-10-31T12:00:00.000Z",
    planId: "0123456789abcdef",
    resourceId: null,
    ownershipMode: entry.ownershipMode ?? null,
    agemonVersion:
      entry.agemonVersion === undefined ? "4.7.2" : entry.agemonVersion,
    fingerprintBefore: null,
    fingerprintAfter: null,
    desiredRevision: null,
    validation: null,
    backup: null,
  };
}

function recordedLedger(entries: FixtureEntry[], version = 3): string {
  return JSON.stringify({
    version,
    createdAt: "2026-10-31T12:00:00.000Z",
    updatedAt: "2026-10-31T12:00:00.000Z",
    os: "linux",
    actions: entries.map(ledgerEntry),
  });
}

const RECORDED_ENTRIES: FixtureEntry[] = [
  {
    plugin: "crg",
    type: "installed-binary",
    target: "code-review-graph (pipx)",
  },
  {
    plugin: "skills",
    type: "installed-skill",
    target: "web-design-guidelines",
  },
  { plugin: "skills", type: "installed-skill", target: "writing-guidelines" },
  {
    plugin: "agents",
    type: "managed-agent-file",
    target: ".claude/agents/geo-audit-content.md",
    ownershipMode: "created",
  },
  {
    plugin: "agents",
    type: "managed-agent-file",
    target: ".claude/agents/geo-audit-schema.md",
    ownershipMode: "created",
  },
  {
    plugin: "master-prompt",
    type: "managed-rule-file",
    target: "AGENTS.md",
    ownershipMode: "delimited-block",
  },
  {
    plugin: "master-prompt",
    type: "managed-rule-file",
    target: "CLAUDE.md",
    ownershipMode: "delimited-block",
    preExisting: true,
  },
];

function writeWebsiteInput(path: string, contents: string): void {
  mkdirSync(join(websiteRoot, path, ".."), { recursive: true });
  writeFileSync(join(websiteRoot, path), contents);
}

let websiteRoot: string;

beforeEach(() => {
  websiteRoot = mkdtempSync(join(tmpdir(), "agemon-site-content-"));
  writeWebsiteInput(SAFETY_POST_PATH, "---\ntitle: Post\n---\n");
  writeWebsiteInput(RECORDED_LEDGER_PATH, recordedLedger(RECORDED_ENTRIES));
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
      /`agemon-commit`\s*\|[^|]+\|\s*first-party \(agemon\)\s*\|\s*—\s*\|\s*MIT/u,
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
    generate({ skillGroups: [hostile, ...SKILL_GROUPS.slice(1)] });
    const page = generatedPage("skills/hostile.md");
    const [, frontmatter, body] = page.split(/^---$/mu);
    expect(Object.keys(parse(frontmatter))).toEqual([
      "title",
      "description",
      "sidebar",
      "provenance",
    ]);
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
      provenance: { generatedFrom: 'x"\nhead: y', chips: [] },
      body: [],
    });
    const lines = page.split("\n");
    const frontmatterLines = lines.slice(1, lines.indexOf("---", 1));
    expect(frontmatterLines).toEqual([
      'title: "T\\n---\\nhead: [{ tag: \\"script\\" }]"',
      'description: "a: b"',
      "sidebar:",
      "  order: 1",
      'provenance: {"generatedFrom":"x\\"\\nhead: y","chips":[]}',
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

function frontmatterOf(page: string): Record<string, unknown> {
  return parse(page.split(/^---$/mu)[1]);
}

function siteData(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(websiteRoot, "src/generated/site-data.json"), "utf8"),
  );
}

const VALID_NOTICE = [
  "- Source: https://github.com/example/skills",
  "- Path in source: skills/x",
  `- Commit: ${"b".repeat(40)}`,
  "- Retrieved: 2026-10-29",
  "- License: MIT — see LICENSE.",
].join("\n");

function vendoredSkillAt(
  skillsRoot: string,
  skillName: string,
  skillManifest: string,
  notice = VALID_NOTICE,
): SkillBundleEntry {
  const source = join(skillsRoot, "fixture", skillName);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), skillManifest);
  writeFileSync(join(source, "NOTICE.md"), notice);
  return { id: skillName, source, skillName, agent: "claude-code" };
}

function withFixtureGroup(skills: SkillBundleEntry[]): SkillGroup[] {
  return [
    {
      id: "fixture",
      label: "Fixture",
      description: "A fixture group.",
      defaultSelected: false,
      skills,
    },
    ...Array.from({ length: SKILL_GROUPS.length - 1 }, (_, index) => ({
      id: `filler-${index}`,
      label: `Filler ${index}`,
      description: "An empty group.",
      defaultSelected: false,
      skills: [],
    })),
  ];
}

describe("site data for the home page", () => {
  it("lists every catalog group once, in catalog order, with the package version and license", () => {
    generate();
    const data = siteData();
    const packageJson = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
    );
    expect(data.version).toBe(packageJson.version);
    expect(data.license).toBe(packageJson.license);
    expect(data.repositoryRef).toBe(REF);
    expect(data.skillGroups).toEqual(
      SKILL_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        description: group.description,
        skillCount: group.skills.length,
        route: `/skills/${group.id}/`,
      })),
    );
  });

  it("fails when the catalog no longer has the ten groups the skill index draws", () => {
    expect(() => generate({ skillGroups: SKILL_GROUPS.slice(1) })).toThrow(
      /skill index has ten places; SKILL_GROUPS has 9/u,
    );
  });

  it("gives every linked route a generated page, and the install anchor a heading on it", () => {
    generate();
    const routes = siteData().routes as Record<string, string>;
    expect(Object.keys(routes).sort()).toEqual(
      [
        "changelog",
        "codeOfConduct",
        "commands",
        "configuration",
        "contributing",
        "gettingStarted",
        "governance",
        "install",
        "safetyPost",
        "security",
        "skills",
      ].sort(),
    );
    const { safetyPost, ...generatedRoutes } = routes;
    expect(join("src/content/docs", `${safetyPost.slice(1, -1)}.mdx`)).toBe(
      SAFETY_POST_PATH,
    );
    for (const route of Object.values(generatedRoutes)) {
      const path = route.replace(/#.*$/u, "");
      const file =
        path === "/skills/" ? "skills/index.md" : `${path.slice(1, -1)}.md`;
      expect(() => generatedPage(file)).not.toThrow();
    }
    const [installPath, installAnchor] = routes.install.split("#");
    expect(installPath).toBe(routes.gettingStarted);
    const gettingStarted = parseMarkdown(
      generatedPage("start/getting-started.md").split(/^---$/mu)[2],
    );
    expect([...headingSlugs(gettingStarted.children).values()]).toContain(
      installAnchor,
    );
  });

  it("fails when the safety-model post the home page links to is missing", () => {
    rmSync(join(websiteRoot, SAFETY_POST_PATH));
    expect(() => generate()).toThrow(
      /src\/content\/docs\/posts\/safety-model\.mdx/u,
    );
  });

  it("generates the code of conduct and governance pages", () => {
    generate();
    expect(generatedPage("project/code-of-conduct.md")).toContain(
      'title: "Code of conduct"',
    );
    expect(generatedPage("project/governance.md")).toContain(
      'title: "Governance"',
    );
  });

  it("says where each generated page comes from", () => {
    generate();
    expect(
      frontmatterOf(generatedPage("reference/commands.md")).provenance,
    ).toEqual({ generatedFrom: "agemon --help" });
    expect(
      frontmatterOf(generatedPage("project/security.md")).provenance,
    ).toEqual({ generatedFrom: "SECURITY.md" });
    expect(
      frontmatterOf(generatedPage("start/getting-started.md")).provenance,
    ).toEqual({ generatedFrom: "README.md" });
  });
});

describe("skill group template", () => {
  let skillsRoot: string;

  beforeEach(() => {
    skillsRoot = mkdtempSync(join(tmpdir(), "agemon-site-skills-"));
  });

  afterEach(() => {
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it("shows shared source, pinned commit and license as chips", () => {
    generate();
    const geoNotice = parseNotice(
      readFileSync(join(SKILLS_ROOT, "geo-seo/geo/NOTICE.md"), "utf8"),
    ).notice;
    expect(
      frontmatterOf(generatedPage("skills/geo-seo.md")).provenance,
    ).toEqual({
      generatedFrom: "the skill catalog and each skill's NOTICE.md",
      chips: [
        { label: "source", value: geoNotice?.source },
        { label: "pinned commit", value: geoNotice?.commit.slice(0, 12) },
        { label: "license", value: "MIT" },
      ],
    });
  });

  it("says per skill when the group's skills differ, and omits a commit chip for first-party skills", () => {
    const firstPartySource = join(skillsRoot, "commit/agemon-commit");
    mkdirSync(firstPartySource, { recursive: true });
    writeFileSync(
      join(firstPartySource, "SKILL.md"),
      "---\nname: agemon-commit\ndescription: Commit.\n---\n",
    );
    const firstParty: SkillBundleEntry = {
      id: "agemon-commit",
      source: firstPartySource,
      skillName: "agemon-commit",
      agent: "claude-code",
    };
    const vendored = vendoredSkillAt(
      skillsRoot,
      "other",
      "---\nname: other\ndescription: Other.\n---\n",
    );
    generate({
      skillGroups: withFixtureGroup([firstParty, vendored]),
      skillsRoot,
    });
    expect(
      (
        frontmatterOf(generatedPage("skills/fixture.md")).provenance as {
          chips: unknown;
        }
      ).chips,
    ).toEqual([
      { label: "source", value: "per skill, see the table" },
      { label: "pinned commit", value: "per skill, see the table" },
      { label: "license", value: "MIT" },
    ]);
    generate();
    expect(
      (
        frontmatterOf(generatedPage("skills/commit.md")).provenance as {
          chips: unknown;
        }
      ).chips,
    ).toEqual([
      { label: "source", value: "first-party (agemon)" },
      { label: "license", value: "MIT" },
    ]);
  });

  it("shows each bundled skill's description, folded or not, and points Essentials upstream", () => {
    generate();
    const geoPage = generatedPage("skills/geo-seo.md");
    expect(geoPage).toMatch(
      /`geo`\s*\|\s*GEO-first SEO analysis tool\. Optimizes websites/u,
    );
    expect(geoPage).toContain("or any URL for analysis. |");
    expect(generatedPage("skills/essentials.md")).toMatch(
      /`web-design-guidelines`\s*\|\s*see upstream\s*\|/u,
    );
  });

  it.each([
    ["an interior line break", "description: |\n  one\n  two\n"],
    ["no description", ""],
    ["a non-string description", "description: [a, b]\n"],
    ["a control character", 'description: "a\\u0007b"\n'],
    [
      "a description over 1024 characters",
      `description: ${"x".repeat(1025)}\n`,
    ],
  ])("fails on a SKILL.md with %s", (_case, descriptionLines) => {
    const skill = vendoredSkillAt(
      skillsRoot,
      "bad",
      `---\nname: bad\n${descriptionLines}---\n`,
    );
    expect(() =>
      generate({ skillGroups: withFixtureGroup([skill]), skillsRoot }),
    ).toThrow(/fixture\/bad\/SKILL\.md: needs a one-line description/u);
  });

  it("renders a hostile description and NOTICE as text", () => {
    const hostileText =
      "a | b <script>alert(1)</script> ```` `c` [x](javascript:y)";
    const skill = vendoredSkillAt(
      skillsRoot,
      "hostile",
      `---\nname: hostile\ndescription: ${JSON.stringify(hostileText)}\n---\n`,
      `${VALID_NOTICE}\n\n\`\`\`\`\`\nbreak out\n<script>alert(1)</script>\n`,
    );
    generate({ skillGroups: withFixtureGroup([skill]), skillsRoot });
    const body = generatedPage("skills/fixture.md").split(/^---$/mu)[2];
    const reparsed = parseMarkdown(body);
    expect(() => assertPublishable(reparsed.children, "page")).not.toThrow();
    const serialized = JSON.stringify(reparsed);
    expect(serialized).toContain("<script>alert(1)</script>");
    expect(
      reparsed.children.filter((node) => node.type === "code"),
    ).toHaveLength(1);
  });

  it.each([
    "see https://evil.example/x",
    "see www.evil.example",
    "mail someone@evil.example",
  ])("fails when a description would render as a link (%s)", (description) => {
    const skill = vendoredSkillAt(
      skillsRoot,
      "linked",
      `---\nname: linked\ndescription: ${description}\n---\n`,
    );
    expect(() =>
      generate({ skillGroups: withFixtureGroup([skill]), skillsRoot }),
    ).toThrow(/skills\/fixture\.md: its text would render as a link to/u);
  });

  it("fails on SKILL.md frontmatter that is not valid YAML, naming the file", () => {
    const skill = vendoredSkillAt(
      skillsRoot,
      "broken",
      "---\nname: broken\ndescription: [a\n---\n",
    );
    expect(() =>
      generate({ skillGroups: withFixtureGroup([skill]), skillsRoot }),
    ).toThrow(/fixture\/broken\/SKILL\.md: frontmatter is not valid YAML/u);
  });

  it("shows each third-party skill's NOTICE and none for first-party skills", () => {
    generate();
    const geoPage = generatedPage("skills/geo-seo.md");
    expect(geoPage).toMatch(/^## NOTICE$/mu);
    expect(geoPage).toContain("Removed `allowed-tools` from the frontmatter");
    expect(generatedPage("skills/commit.md")).not.toMatch(/^## NOTICE$/mu);
  });
});

describe("recorded ledger for the home page", () => {
  it("groups every repository entry by plugin and type in first-seen order, with the files agemon owns", () => {
    writeWebsiteInput(
      RECORDED_LEDGER_PATH,
      recordedLedger([
        ...RECORDED_ENTRIES,
        { plugin: "skills", type: "installed-skill", target: "geo" },
        {
          plugin: "daemon",
          type: "registered-unit",
          target: "/work/run/home/.config/systemd/user/agemon.service",
        },
      ]),
    );
    generate();
    expect(siteData().recordedLedger).toEqual({
      rows: [
        {
          plugin: "crg",
          type: "installed-binary",
          firstTarget: "code-review-graph (pipx)",
          count: 1,
        },
        {
          plugin: "skills",
          type: "installed-skill",
          firstTarget: "web-design-guidelines",
          count: 3,
        },
        {
          plugin: "agents",
          type: "managed-agent-file",
          firstTarget: ".claude/agents/geo-audit-content.md",
          count: 2,
        },
        {
          plugin: "master-prompt",
          type: "managed-rule-file",
          firstTarget: "AGENTS.md",
          count: 2,
        },
      ],
      addedPaths: [".claude/", "AGENTS.md"],
    });
  });

  it("fails with the re-record hint on a ledger the real loader refuses, migrates or cannot show", () => {
    const refused: [string, RegExp][] = [
      ["{", /not valid JSON/u],
      [recordedLedger(RECORDED_ENTRIES, 9), /version: 9/u],
      [recordedLedger(RECORDED_ENTRIES, 2), /older ledger version/u],
      [recordedLedger([]), /no repository entries/u],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "/work/run/home/x.service" },
        ]),
        /no repository entries/u,
      ],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "x" },
          { plugin: "c", type: "d", target: "/home/someone/.ssh/id_ed25519" },
        ]),
        /outside the recording's \/work\//u,
      ],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "x" },
          { plugin: "c", type: "d", target: "/work/x/.." },
        ]),
        /outside the recording's \/work\//u,
      ],
      [
        recordedLedger([{ plugin: "a", type: "b", target: "~/x" }]),
        /relative/u,
      ],
      [
        recordedLedger([{ plugin: "a", type: "b", target: "a/../b" }]),
        /relative/u,
      ],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "evil\u202eexe.md" },
        ]),
        /character/u,
      ],
      [
        recordedLedger([{ plugin: "a", type: "b", target: "x".repeat(121) }]),
        /120/u,
      ],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "x", agemonVersion: null },
        ]),
        /agemon version/u,
      ],
      [
        recordedLedger([
          { plugin: "a", type: "b", target: "x" },
          { plugin: "a", type: "b", target: "y", agemonVersion: "4.7.1" },
        ]),
        /agemon version/u,
      ],
    ];
    for (const [contents, message] of refused) {
      writeWebsiteInput(RECORDED_LEDGER_PATH, contents);
      expect(() => generate(), contents).toThrow(message);
      expect(() => generate(), contents).toThrow(
        /src\/data\/recorded-ledger\.json: .*re-record the website recordings \(website\/recordings\/README\.md\)/u,
      );
    }
  });

  it("accepts the committed recording", () => {
    rmSync(join(websiteRoot, RECORDED_LEDGER_PATH));
    writeWebsiteInput(
      RECORDED_LEDGER_PATH,
      readFileSync(
        join(REPOSITORY_ROOT, "website", RECORDED_LEDGER_PATH),
        "utf8",
      ),
    );
    generate();
    expect(siteData().recordedLedger).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ plugin: "skills" }),
      ]),
    });
  });
});
