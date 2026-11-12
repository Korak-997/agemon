import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { PhrasingContent, RootContent } from "mdast";
import { parse } from "yaml";
import { errorMessage } from "../../src/core/error-message.js";
import { GITHUB_REPOSITORY } from "../../src/core/github-release.js";
import type {
  AgentDefinition,
  SkillBundleEntry,
  SkillGroup,
} from "../../src/plugins/skills/catalog.js";
import { skillFrontmatter } from "../../src/plugins/skills/skill-manifest.js";
import {
  marketplacePluginGroups,
  marketplacePluginName,
} from "../marketplace/manifest.js";
import { FIRST_PARTY_SKILLS, parseNotice } from "../skill-provenance.js";
import { CLAUDE_ROUTE, pluginInstallCommand } from "./claude.js";
import { SiteContentError } from "./error.js";
import { code, heading, link, paragraph, table, text } from "./markdown.js";
import type { GeneratedPage, ProvenanceChip } from "./page.js";

const SHORT_COMMIT_LENGTH = 12;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILLS_DIRECTORY = "skills";
const SKILL_LIBRARY_SOURCE = "the skill catalog and each skill's NOTICE.md";
const FIRST_PARTY_SOURCE = "first-party (agemon)";
const NO_PINNED_COMMIT = "—";
const DIFFERS_PER_SKILL = "per skill, see the table";
const UPSTREAM_DESCRIPTION = "see upstream";
// biome-ignore lint/suspicious/noControlCharactersInRegex: a skill description must stay one plain line, so newlines, tabs and escape bytes are rejected
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

interface SkillProvenance {
  source: string;
  sourceUrl?: string;
  pathInSource?: string;
  commit: string;
  license: string;
  notice?: string;
}

const CLAUDE_PAGE_LINK = link(CLAUDE_ROUTE, "Use agemon with Claude");
export const SKILL_LIBRARY_ROUTE = `/${SKILLS_DIRECTORY}/`;

function agentModelCell(agent: AgentDefinition): PhrasingContent[] {
  const limits = [
    agent.effort === undefined ? [] : [`effort ${agent.effort}`],
    agent.maxTurns === undefined ? [] : [`at most ${agent.maxTurns} turns`],
  ].flat();
  return [
    agent.model === undefined ? text("the session's model") : code(agent.model),
    ...(limits.length === 0 ? [] : [text(`, ${limits.join(", ")}`)]),
  ];
}

export function skillGroupRoute(group: SkillGroup): string {
  return `${SKILL_LIBRARY_ROUTE}${group.id}/`;
}

function skillProvenance(
  skill: SkillBundleEntry,
  skillsRoot: string,
): SkillProvenance {
  if (skill.pinnedRepository) {
    const { url, commit } = skill.pinnedRepository;
    const repositoryPage = url.replace(/\.git$/u, "");
    return {
      source: repositoryPage,
      sourceUrl: `${repositoryPage}/tree/${commit}`,
      commit: commit.slice(0, SHORT_COMMIT_LENGTH),
      license: "see the upstream repository",
    };
  }
  const skillPath = relative(skillsRoot, skill.source).split(sep).join("/");
  if (FIRST_PARTY_SKILLS.includes(skillPath)) {
    return {
      source: FIRST_PARTY_SOURCE,
      commit: NO_PINNED_COMMIT,
      license: "MIT",
    };
  }
  const noticePath = `${skill.source}/NOTICE.md`;
  const noticeText = readFileSync(noticePath, "utf8");
  const { notice, fieldsNotExactlyOnce } = parseNotice(noticeText);
  if (!notice) {
    throw new SiteContentError(
      `${noticePath}: needs ${fieldsNotExactlyOnce.join(", ")}; run npm run lint-skills`,
    );
  }
  return {
    source: notice.source,
    sourceUrl: notice.source,
    pathInSource: notice.pathInSource,
    commit: notice.commit.slice(0, SHORT_COMMIT_LENGTH),
    license: notice.license,
    notice: noticeText,
  };
}

function parsedFrontmatter(manifestPath: string): Record<string, unknown> {
  const frontmatter = skillFrontmatter(readFileSync(manifestPath, "utf8"));
  if (frontmatter === undefined) return {};
  try {
    return parse(frontmatter) ?? {};
  } catch (error) {
    throw new SiteContentError(
      `${manifestPath}: frontmatter is not valid YAML (${errorMessage(error)}); fix the YAML frontmatter`,
    );
  }
}

function skillDescription(skill: SkillBundleEntry): string {
  if (skill.pinnedRepository) return UPSTREAM_DESCRIPTION;
  const manifestPath = `${skill.source}/SKILL.md`;
  const { description } = parsedFrontmatter(manifestPath);
  const oneLine =
    typeof description === "string" ? description.replace(/\n$/u, "") : "";
  if (
    oneLine.length === 0 ||
    oneLine.length > MAX_DESCRIPTION_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(oneLine)
  ) {
    throw new SiteContentError(
      `${manifestPath}: needs a one-line description of at most ${MAX_DESCRIPTION_LENGTH} characters without control characters`,
    );
  }
  return oneLine;
}

function sharedValue(values: string[]): string {
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : DIFFERS_PER_SKILL;
}

function provenanceChips(provenances: SkillProvenance[]): ProvenanceChip[] {
  const commit = sharedValue(provenances.map(({ commit }) => commit));
  return [
    {
      label: "source",
      value: sharedValue(provenances.map(({ source }) => source)),
    },
    ...(commit === NO_PINNED_COMMIT
      ? []
      : [{ label: "pinned commit", value: commit }]),
    {
      label: "license",
      value: sharedValue(provenances.map(({ license }) => license)),
    },
  ];
}

function sourceCell(provenance: SkillProvenance): PhrasingContent[] {
  if (!provenance.sourceUrl) return [text(provenance.source)];
  const sourceLink = link(provenance.sourceUrl, provenance.source);
  return provenance.pathInSource
    ? [sourceLink, text(` (${provenance.pathInSource})`)]
    : [sourceLink];
}

function commitCell(provenance: SkillProvenance): PhrasingContent[] {
  return provenance.commit === NO_PINNED_COMMIT
    ? [text(provenance.commit)]
    : [code(provenance.commit)];
}

function addToClaude(group: SkillGroup): RootContent[] {
  return [
    heading(text("Add to Claude")),
    paragraph(
      text("This group is also the "),
      code(marketplacePluginName(group)),
      text(" plugin in the "),
      code(GITHUB_REPOSITORY),
      text(
        " marketplace, for claude.ai and Claude Code. In Claude Code, after adding the marketplace:",
      ),
    ),
    { type: "code", lang: "bash", value: pluginInstallCommand(group) },
    paragraph(
      text("For claude.ai and the full steps, see "),
      CLAUDE_PAGE_LINK,
      text("."),
    ),
  ];
}

function skillGroupPage(
  group: SkillGroup,
  sidebarOrder: number,
  skillsRoot: string,
  isPlugin: boolean,
): GeneratedPage {
  const skills = group.skills.map((skill) => ({
    skill,
    provenance: skillProvenance(skill, skillsRoot),
    description: skillDescription(skill),
  }));
  const body: RootContent[] = [
    paragraph(text(group.description)),
    paragraph(
      text("Install it with "),
      code(`agemon --skill-groups ${group.id}`),
      text(
        group.defaultSelected
          ? ". It is selected by default."
          : ", or pick it in the interactive prompt.",
      ),
    ),
    ...(isPlugin ? addToClaude(group) : []),
    heading(text("Skills")),
    table(
      ["Skill", "Description", "Source", "Commit", "License"],
      skills.map(({ skill, provenance, description }) => [
        [code(skill.skillName)],
        [text(description)],
        sourceCell(provenance),
        commitCell(provenance),
        [text(provenance.license)],
      ]),
    ),
  ];
  if (group.agents?.length) {
    body.push(
      heading(text("Subagents")),
      table(
        ["Agent", "Tools", "Model", "Purpose"],
        group.agents.map((agent) => [
          [code(agent.name)],
          [code(agent.tools.join(", "))],
          agentModelCell(agent),
          [text(agent.description)],
        ]),
      ),
    );
  }
  const notices = skills.flatMap(({ skill, provenance }): RootContent[] =>
    provenance.notice === undefined
      ? []
      : [
          heading(text(skill.skillName), 3),
          { type: "code", lang: "text", value: provenance.notice },
        ],
  );
  if (notices.length > 0) {
    body.push(heading(text("NOTICE")), ...notices);
  }
  return {
    path: `${SKILLS_DIRECTORY}/${group.id}.md`,
    title: group.label,
    description: group.description,
    sidebarOrder,
    provenance: {
      generatedFrom: SKILL_LIBRARY_SOURCE,
      chips: provenanceChips(skills.map(({ provenance }) => provenance)),
    },
    body,
  };
}

function skillLibraryIndexPage(groups: readonly SkillGroup[]): GeneratedPage {
  return {
    path: `${SKILLS_DIRECTORY}/index.md`,
    title: "Skill library",
    description: "Every skill group agemon can install, with its sources.",
    sidebarOrder: 0,
    provenance: { generatedFrom: SKILL_LIBRARY_SOURCE },
    body: [
      paragraph(
        text(
          "Each group is a set of Claude Code skills agemon installs into a repository. Pick groups with ",
        ),
        code("--skill-groups"),
        text(" or in the interactive prompt."),
      ),
      paragraph(
        text(
          "The groups are also Claude plugins for claude.ai and Claude Code. See ",
        ),
        CLAUDE_PAGE_LINK,
        text("."),
      ),
      table(
        ["Group", "Id", "Skills", "Default", "Description"],
        groups.map((group) => [
          [link(skillGroupRoute(group), group.label)],
          [code(group.id)],
          [text(String(group.skills.length))],
          [text(group.defaultSelected ? "yes" : "no")],
          [text(group.description)],
        ]),
      ),
    ],
  };
}

export function skillLibraryPages(
  groups: readonly SkillGroup[],
  skillsRoot: string,
): GeneratedPage[] {
  const pluginGroups = new Set(marketplacePluginGroups(groups));
  return [
    skillLibraryIndexPage(groups),
    ...groups.map((group, index) =>
      skillGroupPage(group, index + 1, skillsRoot, pluginGroups.has(group)),
    ),
  ];
}
