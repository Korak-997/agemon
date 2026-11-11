import { basename, dirname } from "node:path";
import type { SkillGroup } from "../../src/plugins/skills/catalog.js";

export const MARKETPLACE_MANIFEST_PATH = ".claude-plugin/marketplace.json";

export const MARKETPLACE_NAME = "agemon";
const MARKETPLACE_OWNER = "Korak-997";
const MARKETPLACE_DESCRIPTION =
  "agemon's skill groups for Claude: pick the groups you want, in claude.ai or Claude Code.";
const PLUGIN_NAME_PREFIX = "agemon-";
const SKILL_FOLDERS_IN_PLUGIN_ROOT = "./";

interface MarketplacePlugin {
  name: string;
  description: string;
  source: string;
  strict: false;
  skills: string[];
}

export interface MarketplaceManifest {
  name: string;
  owner: { name: string };
  description: string;
  plugins: MarketplacePlugin[];
}

function isFullyVendored(group: SkillGroup): boolean {
  return group.skills.every((skill) => skill.pinnedRepository === undefined);
}

function groupFolder(group: SkillGroup): string {
  return basename(dirname(group.skills[0].source));
}

export function marketplacePluginGroups(
  groups: readonly SkillGroup[],
): SkillGroup[] {
  return groups.filter(isFullyVendored);
}

export function marketplacePluginName(group: SkillGroup): string {
  return `${PLUGIN_NAME_PREFIX}${group.id}`;
}

export function buildMarketplaceManifest(
  groups: readonly SkillGroup[],
): MarketplaceManifest {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: MARKETPLACE_OWNER },
    description: MARKETPLACE_DESCRIPTION,
    plugins: marketplacePluginGroups(groups).map((group) => ({
      name: marketplacePluginName(group),
      description: group.description,
      source: `./assets/skills/${groupFolder(group)}`,
      strict: false,
      skills: [SKILL_FOLDERS_IN_PLUGIN_ROOT],
    })),
  };
}

function parsesToSameManifest(
  committed: string,
  expected: MarketplaceManifest,
): boolean {
  try {
    return JSON.stringify(JSON.parse(committed)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export function findMarketplaceMismatch(
  committed: string,
  groups: readonly SkillGroup[],
): string[] {
  return parsesToSameManifest(committed, buildMarketplaceManifest(groups))
    ? []
    : [
        `${MARKETPLACE_MANIFEST_PATH} does not match the skill catalog; run 'npm run marketplace' and commit the result`,
      ];
}
