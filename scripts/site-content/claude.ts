import type { RootContent } from "mdast";
import type { SkillGroup } from "../../src/plugins/skills/catalog.js";
import {
  MARKETPLACE_NAME,
  marketplacePluginGroups,
  marketplacePluginName,
} from "../marketplace/manifest.js";
import { code, extractSection, table, text } from "./markdown.js";

export const CLAUDE_ROUTE = "/start/claude/";
const PLUGIN_NAMES_HEADING = "Plugin names";

export function pluginInstallCommand(group: SkillGroup): string {
  return `claude plugin install ${marketplacePluginName(group)}@${MARKETPLACE_NAME}`;
}

function pluginNamesTable(groups: readonly SkillGroup[]): RootContent {
  return table(
    ["Group", "Plugin", "Description"],
    marketplacePluginGroups(groups).map((group) => [
      [text(group.label)],
      [code(marketplacePluginName(group))],
      [text(group.description)],
    ]),
  );
}

export function claudePageBody(
  readmeBody: RootContent[],
  skillGroups: readonly SkillGroup[],
): RootContent[] {
  const pluginNamesSection = extractSection(
    { type: "root", children: readmeBody },
    PLUGIN_NAMES_HEADING,
    "README.md",
  );
  const pluginNamesEnd =
    readmeBody.indexOf(pluginNamesSection[0]) + pluginNamesSection.length;
  return [
    ...readmeBody.slice(0, pluginNamesEnd),
    pluginNamesTable(skillGroups),
    ...readmeBody.slice(pluginNamesEnd),
  ];
}
