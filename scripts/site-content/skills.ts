import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type {
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";
import type {
  SkillBundleEntry,
  SkillGroup,
} from "../../src/plugins/skills/catalog.js";
import { FIRST_PARTY_SKILLS, parseNotice } from "../skill-provenance.js";
import { SiteContentError } from "./error.js";
import type { GeneratedPage } from "./page.js";

const SHORT_COMMIT_LENGTH = 12;
const SKILLS_DIRECTORY = "skills";

interface SkillProvenance {
  source: PhrasingContent[];
  commit: PhrasingContent[];
  license: PhrasingContent[];
}

const text = (value: string): PhrasingContent => ({ type: "text", value });
const code = (value: string): PhrasingContent => ({
  type: "inlineCode",
  value,
});
const link = (url: string, label: string): PhrasingContent => ({
  type: "link",
  url,
  children: [text(label)],
});
const paragraph = (...children: PhrasingContent[]): RootContent => ({
  type: "paragraph",
  children,
});
const heading = (value: string): RootContent => ({
  type: "heading",
  depth: 2,
  children: [text(value)],
});

function table(header: string[], rows: PhrasingContent[][][]): Table {
  const row = (cells: PhrasingContent[][]): TableRow => ({
    type: "tableRow",
    children: cells.map(
      (children): TableCell => ({ type: "tableCell", children }),
    ),
  });
  return {
    type: "table",
    children: [row(header.map((label) => [text(label)])), ...rows.map(row)],
  };
}

function skillGroupRoute(group: SkillGroup): string {
  return `/${SKILLS_DIRECTORY}/${group.id}/`;
}

function skillProvenance(
  skill: SkillBundleEntry,
  skillsRoot: string,
): SkillProvenance {
  if (skill.pinnedRepository) {
    const { url, commit } = skill.pinnedRepository;
    const repositoryPage = url.replace(/\.git$/u, "");
    return {
      source: [link(`${repositoryPage}/tree/${commit}`, repositoryPage)],
      commit: [code(commit.slice(0, SHORT_COMMIT_LENGTH))],
      license: [text("see the upstream repository")],
    };
  }
  const skillPath = relative(skillsRoot, skill.source).split(sep).join("/");
  if (FIRST_PARTY_SKILLS.includes(skillPath)) {
    return {
      source: [text("first-party (agemon)")],
      commit: [text("—")],
      license: [text("MIT")],
    };
  }
  const noticePath = `${skill.source}/NOTICE.md`;
  const { notice, fieldsNotExactlyOnce } = parseNotice(
    readFileSync(noticePath, "utf8"),
  );
  if (!notice) {
    throw new SiteContentError(
      `${noticePath}: needs ${fieldsNotExactlyOnce.join(", ")}; run npm run lint-skills`,
    );
  }
  return {
    source: [
      link(notice.source, notice.source),
      text(` (${notice.pathInSource})`),
    ],
    commit: [code(notice.commit.slice(0, SHORT_COMMIT_LENGTH))],
    license: [text(notice.license)],
  };
}

function skillGroupPage(
  group: SkillGroup,
  sidebarOrder: number,
  skillsRoot: string,
): GeneratedPage {
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
    heading("Skills"),
    table(
      ["Skill", "Source", "Commit", "License"],
      group.skills.map((skill) => {
        const provenance = skillProvenance(skill, skillsRoot);
        return [
          [code(skill.skillName)],
          provenance.source,
          provenance.commit,
          provenance.license,
        ];
      }),
    ),
  ];
  if (group.agents?.length) {
    body.push(
      heading("Subagents"),
      table(
        ["Agent", "Tools", "Purpose"],
        group.agents.map((agent) => [
          [code(agent.name)],
          [code(agent.tools.join(", "))],
          [text(agent.description)],
        ]),
      ),
    );
  }
  return {
    path: `${SKILLS_DIRECTORY}/${group.id}.md`,
    title: group.label,
    description: group.description,
    sidebarOrder,
    body,
  };
}

function skillLibraryIndexPage(groups: readonly SkillGroup[]): GeneratedPage {
  return {
    path: `${SKILLS_DIRECTORY}/index.md`,
    title: "Skill library",
    description: "Every skill group agemon can install, with its sources.",
    sidebarOrder: 0,
    body: [
      paragraph(
        text(
          "Each group is a set of Claude Code skills agemon installs into a repository. Pick groups with ",
        ),
        code("--skill-groups"),
        text(" or in the interactive prompt."),
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
  return [
    skillLibraryIndexPage(groups),
    ...groups.map((group, index) =>
      skillGroupPage(group, index + 1, skillsRoot),
    ),
  ];
}
