import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import type { RootContent } from "mdast";
import { GITHUB_REPOSITORY } from "../../src/core/github-release.js";
import type { SkillGroup } from "../../src/plugins/skills/catalog.js";
import { groupChangelogReleases } from "./changelog.js";
import { COMMANDS_ROUTE, commandsPage } from "./commands.js";
import { configurationPageBody } from "./configuration.js";
import { SiteContentError } from "./error.js";
import { checksumInstallScript } from "./install-script.js";
import {
  assertPublishable,
  extractSection,
  headingSlugs,
  type LinkTargets,
  parseMarkdown,
  plainText,
  rewriteLinks,
  serializeMarkdown,
  shiftHeadingsToStartAtLevelTwo,
  visit,
  withoutLeadingTitle,
} from "./markdown.js";
import { type GeneratedPage, pagePathFromRoute, renderPage } from "./page.js";
import {
  RECORDED_LEDGER_PATH,
  summarizeRecordedLedger,
} from "./recorded-ledger.js";
import {
  SKILL_LIBRARY_ROUTE,
  skillGroupRoute,
  skillLibraryPages,
} from "./skills.js";

const DOCS_DIRECTORY = "src/content/docs";
const GENERATED_DOCS_DIRECTORIES = ["start", "reference", "skills", "project"];
const SITE_DATA_PATH = "src/generated/site-data.json";
const SERVED_INSTALL_SCRIPT_PATH = "public/install.sh";
const SAFETY_POST_ROUTE = "/posts/safety-model/";
const INSTALL_HEADING = "Install";
const SKILL_INDEX_PLACES = 10;

type RouteName =
  | "gettingStarted"
  | "configuration"
  | "security"
  | "contributing"
  | "codeOfConduct"
  | "governance"
  | "changelog";

interface ReadmePage {
  routeName: RouteName;
  route: string;
  title: string;
  description: string;
  sidebarOrder: number;
  headings: string[];
  generatedFrom?: string;
  compose?: (readmeBody: RootContent[]) => RootContent[];
}

const README_PAGES: ReadmePage[] = [
  {
    routeName: "gettingStarted",
    route: "/start/getting-started/",
    title: "Getting started",
    description: "Requirements and the ways to install agemon.",
    sidebarOrder: 1,
    headings: ["Requirements", INSTALL_HEADING],
  },
  {
    routeName: "configuration",
    route: "/reference/configuration/",
    title: "Configuration",
    description: "The agemon.toml reference and agemon's exit codes.",
    sidebarOrder: 2,
    headings: ["agemon.toml", "Exit codes"],
    generatedFrom: "src/core/config.ts and README.md",
    compose: configurationPageBody,
  },
];

interface FilePage {
  routeName?: RouteName;
  source: string;
  route: string;
  title: string;
  description: string;
  sidebarOrder: number;
  compose?: (body: RootContent[]) => RootContent[];
}

const FILE_PAGES: FilePage[] = [
  {
    routeName: "security",
    source: "SECURITY.md",
    route: "/project/security/",
    title: "Security",
    description: "How to report a vulnerability and agemon's trust model.",
    sidebarOrder: 1,
  },
  {
    routeName: "contributing",
    source: "CONTRIBUTING.md",
    route: "/project/contributing/",
    title: "Contributing",
    description: "How to work on agemon.",
    sidebarOrder: 2,
  },
  {
    routeName: "codeOfConduct",
    source: "CODE_OF_CONDUCT.md",
    route: "/project/code-of-conduct/",
    title: "Code of conduct",
    description: "How the agemon community treats each other.",
    sidebarOrder: 3,
  },
  {
    routeName: "governance",
    source: "GOVERNANCE.md",
    route: "/project/governance/",
    title: "Governance",
    description: "Who decides what in agemon, and how.",
    sidebarOrder: 4,
  },
  {
    source: "docs/contributing/adding-a-skill.md",
    route: "/project/adding-a-skill/",
    title: "Adding a skill",
    description: "How to bundle a new skill with agemon.",
    sidebarOrder: 5,
  },
  {
    source: "docs/contributing/writing-a-plugin.md",
    route: "/project/writing-a-plugin/",
    title: "Writing a capability plugin",
    description: "The plugin contract agemon's capabilities implement.",
    sidebarOrder: 6,
  },
  {
    routeName: "changelog",
    source: "CHANGELOG.md",
    route: "/project/changelog/",
    title: "Changelog",
    description: "What changed in each agemon release.",
    sidebarOrder: 7,
    compose: groupChangelogReleases,
  },
];

export interface SiteContentOptions {
  repositoryRoot: string;
  websiteRoot: string;
  skillGroups: readonly SkillGroup[];
  skillsRoot: string;
  program: Command;
  installScriptPath: string;
  sha256SumsPath?: string;
  releaseTag?: string;
  repositoryRef: string;
}

function readmePages(
  options: SiteContentOptions,
  routeForFile: ReadonlyMap<string, string>,
): GeneratedPage[] {
  const readme = parseMarkdown(
    readFileSync(join(options.repositoryRoot, "README.md"), "utf8"),
  );
  const readmeSlugs = headingSlugs(readme.children);
  const sections = README_PAGES.map((page) =>
    page.headings.flatMap((headingText) =>
      extractSection(readme, headingText, "README.md"),
    ),
  );
  const routeForReadmeAnchor = new Map<string, string>();
  for (const [index, page] of README_PAGES.entries()) {
    for (const [heading, pageSlug] of headingSlugs(sections[index])) {
      const readmeSlug = readmeSlugs.get(heading);
      if (readmeSlug)
        routeForReadmeAnchor.set(readmeSlug, `${page.route}#${pageSlug}`);
    }
  }
  const targets: LinkTargets = {
    routeForFile,
    routeForReadmeAnchor,
    repositoryRef: options.repositoryRef,
  };
  return README_PAGES.map((page, index) => {
    const body = sections[index];
    assertPublishable(body, "README.md");
    rewriteLinks(body, "README.md", targets);
    shiftHeadingsToStartAtLevelTwo(body);
    return {
      path: pagePathFromRoute(page.route),
      title: page.title,
      description: page.description,
      sidebarOrder: page.sidebarOrder,
      provenance: { generatedFrom: page.generatedFrom ?? "README.md" },
      body: page.compose?.(body) ?? body,
    };
  });
}

function filePages(
  options: SiteContentOptions,
  routeForFile: ReadonlyMap<string, string>,
): GeneratedPage[] {
  const targets: LinkTargets = {
    routeForFile,
    routeForReadmeAnchor: new Map(),
    repositoryRef: options.repositoryRef,
  };
  return FILE_PAGES.map((page) => {
    const body = withoutLeadingTitle(
      parseMarkdown(
        readFileSync(join(options.repositoryRoot, page.source), "utf8"),
      ),
    );
    assertPublishable(body, page.source);
    rewriteLinks(body, page.source, targets);
    shiftHeadingsToStartAtLevelTwo(body);
    return {
      path: pagePathFromRoute(page.route),
      title: page.title,
      description: page.description,
      sidebarOrder: page.sidebarOrder,
      provenance: { generatedFrom: page.source },
      body: page.compose?.(body) ?? body,
    };
  });
}

function assertSkillIndexFits(skillGroups: readonly SkillGroup[]): void {
  if (skillGroups.length !== SKILL_INDEX_PLACES) {
    throw new SiteContentError(
      `the home page's skill index has ten places; SKILL_GROUPS has ${skillGroups.length} — update website/src/components/TetractysIndex.astro and the "Ten groups" heading in website/src/content/docs/index.mdx`,
    );
  }
}

function headingAnchor(page: GeneratedPage, headingText: string): string {
  for (const [heading, slug] of headingSlugs(page.body)) {
    if (plainText(heading) === headingText) return slug;
  }
  throw new SiteContentError(
    `${page.path} has no "${headingText}" heading to link to`,
  );
}

function siteRoutes(pages: readonly GeneratedPage[]): Record<string, string> {
  const namedPages = [...README_PAGES, ...FILE_PAGES].filter(
    (page) => page.routeName !== undefined,
  );
  const routes: Record<string, string> = Object.fromEntries(
    namedPages.map((page) => [page.routeName, page.route]),
  );
  const gettingStartedPath = pagePathFromRoute(routes.gettingStarted);
  const gettingStarted = pages.find((page) => page.path === gettingStartedPath);
  if (gettingStarted === undefined) {
    throw new SiteContentError(`no generated page at ${gettingStartedPath}`);
  }
  return {
    ...routes,
    install: `${routes.gettingStarted}#${headingAnchor(gettingStarted, INSTALL_HEADING)}`,
    commands: COMMANDS_ROUTE,
    skills: SKILL_LIBRARY_ROUTE,
    safetyPost: SAFETY_POST_ROUTE,
  };
}

function assertSafetyPostExists(websiteRoot: string): void {
  const postPath = join(
    DOCS_DIRECTORY,
    `${SAFETY_POST_ROUTE.slice(1, -1)}.mdx`,
  );
  if (!existsSync(join(websiteRoot, postPath))) {
    throw new SiteContentError(
      `${postPath} is missing; the home page and the footer link to it`,
    );
  }
}

function linkUrls(nodes: readonly RootContent[]): Set<string> {
  const urls = new Set<string>();
  for (const node of nodes) {
    visit(node, (child) => {
      if (child.type === "link") urls.add(child.url);
    });
  }
  return urls;
}

function assertRendersPublishable(page: GeneratedPage): void {
  const rendered = parseMarkdown(
    serializeMarkdown({ type: "root", children: page.body }),
  ).children;
  assertPublishable(rendered, page.path);
  const createdLinks = linkUrls(page.body);
  const unexpectedLink = [...linkUrls(rendered)].find(
    (url) => !createdLinks.has(url),
  );
  if (unexpectedLink !== undefined) {
    throw new SiteContentError(
      `${page.path}: its text would render as a link to ${unexpectedLink}; remove the URL or address from the source text`,
    );
  }
}

function writeFile(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function generateSiteContent(options: SiteContentOptions): void {
  assertSkillIndexFits(options.skillGroups);
  assertSafetyPostExists(options.websiteRoot);
  const recordedLedger = summarizeRecordedLedger(
    readFileSync(join(options.websiteRoot, RECORDED_LEDGER_PATH), "utf8"),
  );
  const { version, description, license } = JSON.parse(
    readFileSync(join(options.repositoryRoot, "package.json"), "utf8"),
  ) as { version: string; description: string; license: string };
  const routeForFile = new Map(
    FILE_PAGES.map((page) => [page.source, page.route]),
  );
  const pages = [
    ...readmePages(options, routeForFile),
    ...filePages(options, routeForFile),
    commandsPage(options.program, version),
    ...skillLibraryPages(options.skillGroups, options.skillsRoot),
  ];
  const installScript = readFileSync(options.installScriptPath);
  const installSh = checksumInstallScript(
    installScript,
    options.sha256SumsPath === undefined
      ? undefined
      : readFileSync(options.sha256SumsPath, "utf8"),
  );

  const docsRoot = join(options.websiteRoot, DOCS_DIRECTORY);
  for (const directory of GENERATED_DOCS_DIRECTORIES) {
    rmSync(join(docsRoot, directory), { recursive: true, force: true });
  }
  for (const page of pages) {
    assertRendersPublishable(page);
    writeFile(join(docsRoot, page.path), renderPage(page));
  }
  writeFile(
    join(options.websiteRoot, SITE_DATA_PATH),
    `${JSON.stringify(
      {
        description,
        version,
        license,
        repository: GITHUB_REPOSITORY,
        repositoryRef: options.repositoryRef,
        routes: siteRoutes(pages),
        skillGroups: options.skillGroups.map((group) => ({
          id: group.id,
          label: group.label,
          description: group.description,
          skillCount: group.skills.length,
          route: skillGroupRoute(group),
        })),
        recordedLedger,
        releaseTag: options.releaseTag ?? null,
        installSh,
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(options.websiteRoot, SERVED_INSTALL_SCRIPT_PATH),
    installScript,
  );
}
