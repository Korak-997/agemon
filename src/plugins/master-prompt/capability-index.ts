import { printable } from "../../core/untrusted-text.js";

export const CAPABILITY_INDEX_BLOCK_ID = "capability-index";
export const MAX_INDEXED_SKILL_ROWS = 40;

const PLAIN_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export interface IndexedSkill {
  skillName: string;
  routeHint: string | null;
}

export interface IndexedTool {
  routeHint: string;
  indexCommand: string;
}

function renderSkillRow({ skillName, routeHint }: IndexedSkill): string {
  return routeHint === null
    ? `| Defined in this repository's agemon.toml | \`${skillName}\`: read its SKILL.md description first |`
    : `| ${routeHint} | \`${skillName}\` |`;
}

function renderSkillsSection(skills: readonly IndexedSkill[]): string[] {
  const indexable = skills
    .map((skill) => ({ ...skill, skillName: printable(skill.skillName) }))
    .filter((skill) => PLAIN_SKILL_NAME.test(skill.skillName));
  if (indexable.length === 0) {
    return [];
  }
  const rows = indexable.slice(0, MAX_INDEXED_SKILL_ROWS).map(renderSkillRow);
  const overflowCount = indexable.length - MAX_INDEXED_SKILL_ROWS;
  if (overflowCount > 0) {
    rows.push(`| ${overflowCount} more skills | see \`.claude/skills/\` |`);
  }
  return [
    "",
    "### Skills",
    "",
    "| When the task is | Use |",
    "|---|---|",
    ...rows,
  ];
}

function renderToolsSection(tools: readonly IndexedTool[]): string[] {
  if (tools.length === 0) {
    return [];
  }
  return [
    "",
    "### Tools",
    "",
    "| Need | Command |",
    "|---|---|",
    ...tools.map((tool) => `| ${tool.routeHint} | ${tool.indexCommand} |`),
  ];
}

export function buildCapabilityIndexBlockBody(
  skills: readonly IndexedSkill[],
  tools: readonly IndexedTool[],
): string {
  return [
    "## Capability Index",
    "",
    "Installed by agemon in this repository. Before starting a task, find the row that matches it and load that skill by name. If no row matches, continue without one.",
    ...renderSkillsSection(skills),
    ...renderToolsSection(tools),
  ].join("\n");
}
