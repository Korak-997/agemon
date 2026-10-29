import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Heading, RootContent } from "mdast";
import { GITHUB_REPOSITORY } from "../../src/core/github-release.js";
import type { SkillGroup } from "../../src/plugins/skills/catalog.js";
import { collectCliHelp, type HelpRunner } from "./help.js";
import { checksumInstallScript } from "./install-script.js";
import {
  assertPublishable,
  extractSection,
  headingSlugs,
  type LinkTargets,
  parseMarkdown,
  rewriteLinks,
  shiftHeadingsToStartAtLevelTwo,
  withoutLeadingTitle,
} from "./markdown.js";
import { type GeneratedPage, renderPage } from "./page.js";
import { skillLibraryPages } from "./skills.js";

const DOCS_DIRECTORY = "src/content/docs";
const GENERATED_DOCS_DIRECTORIES = ["start", "reference", "skills", "project"];
const SITE_DATA_PATH = "src/generated/site-data.json";
const SERVED_INSTALL_SCRIPT_PATH = "public/install.sh";

interface ReadmePage {
  route: string;
  title: string;
  description: string;
  sidebarOrder: number;
  headings: string[];
}

const README_PAGES: ReadmePage[] = [
  {
    route: "/start/getting-started/",
    title: "Getting started",
    description: "Requirements and the ways to install agemon.",
    sidebarOrder: 1,
    headings: ["Requirements", "Install"],
  },
  {
    route: "/reference/configuration/",
    title: "Configuration",
    description: "The agemon.toml reference and agemon's exit codes.",
    sidebarOrder: 2,
    headings: ["agemon.toml", "Exit codes"],
  },
];

interface FilePage {
  source: string;
  route: string;
  title: string;
  description: string;
  sidebarOrder: number;
}

const FILE_PAGES: FilePage[] = [
  {
    source: "SECURITY.md",
    route: "/project/security/",
    title: "Security",
    description: "How to report a vulnerability and agemon's trust model.",
    sidebarOrder: 1,
  },
  {
    source: "CONTRIBUTING.md",
    route: "/project/contributing/",
    title: "Contributing",
    description: "How to work on agemon.",
    sidebarOrder: 2,
  },
  {
    source: "docs/contributing/adding-a-skill.md",
    route: "/project/adding-a-skill/",
    title: "Adding a skill",
    description: "How to bundle a new skill with agemon.",
    sidebarOrder: 3,
  },
  {
    source: "docs/contributing/writing-a-plugin.md",
    route: "/project/writing-a-plugin/",
    title: "Writing a capability plugin",
    description: "The plugin contract agemon's capabilities implement.",
    sidebarOrder: 4,
  },
  {
    source: "CHANGELOG.md",
    route: "/project/changelog/",
    title: "Changelog",
    description: "What changed in each agemon release.",
    sidebarOrder: 5,
  },
];

export interface SiteContentOptions {
  repositoryRoot: string;
  websiteRoot: string;
  skillGroups: readonly SkillGroup[];
  skillsRoot: string;
  runHelp: HelpRunner;
  installScriptPath: string;
  sha256SumsPath?: string;
  releaseTag?: string;
  repositoryRef: string;
}

function pagePathFromRoute(route: string): string {
  return `${route.slice(1, -1)}.md`;
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
      body,
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
      body,
    };
  });
}

function commandsPage(runHelp: HelpRunner, version: string): GeneratedPage {
  const help = collectCliHelp(runHelp);
  const helpBlock = (heading: string, output: string): RootContent[] => [
    {
      type: "heading",
      depth: 2,
      children: [{ type: "inlineCode", value: heading }],
    } satisfies Heading,
    { type: "code", lang: "text", value: output },
  ];
  return {
    path: "reference/commands.md",
    title: "Commands",
    description: "Every agemon command and option, from agemon --help.",
    sidebarOrder: 1,
    body: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "The output of " },
          { type: "inlineCode", value: "agemon --help" },
          {
            type: "text",
            value: ` for every command, from agemon ${version}.`,
          },
        ],
      },
      ...helpBlock("agemon", help.root),
      ...help.commands.flatMap((command) =>
        helpBlock(`agemon ${command.name}`, command.help),
      ),
    ],
  };
}

function writeFile(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function generateSiteContent(options: SiteContentOptions): void {
  const { version, description } = JSON.parse(
    readFileSync(join(options.repositoryRoot, "package.json"), "utf8"),
  ) as { version: string; description: string };
  const routeForFile = new Map(
    FILE_PAGES.map((page) => [page.source, page.route]),
  );
  const pages = [
    ...readmePages(options, routeForFile),
    ...filePages(options, routeForFile),
    commandsPage(options.runHelp, version),
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
    writeFile(join(docsRoot, page.path), renderPage(page));
  }
  writeFile(
    join(options.websiteRoot, SITE_DATA_PATH),
    `${JSON.stringify(
      {
        description,
        repository: GITHUB_REPOSITORY,
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
