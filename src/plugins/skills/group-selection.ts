import { multiselect } from "@clack/prompts";
import type { Context } from "../../core/context.js";
import { assertNotCancelled } from "../../core/prompt-clack.js";
import { SKILL_GROUPS, type SkillGroup } from "./catalog.js";

const ALL_GROUPS_KEYWORD = "all";
const NO_GROUPS_KEYWORD = "none";

function parseExplicitGroupIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function defaultGroups(): SkillGroup[] {
  return SKILL_GROUPS.filter((group) => group.defaultSelected);
}

function optionalGroups(): SkillGroup[] {
  return SKILL_GROUPS.filter((group) => !group.defaultSelected);
}

function resolveExplicitGroups(skillGroupsOption: string): SkillGroup[] {
  const trimmedOption = skillGroupsOption.trim().toLowerCase();
  if (trimmedOption === NO_GROUPS_KEYWORD) {
    return defaultGroups();
  }
  if (trimmedOption === ALL_GROUPS_KEYWORD) {
    return SKILL_GROUPS;
  }

  const requestedIds = parseExplicitGroupIds(skillGroupsOption);
  const groupById = new Map(SKILL_GROUPS.map((group) => [group.id, group]));
  const unknownIds = requestedIds.filter((id) => !groupById.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown skill group id(s): ${unknownIds.join(", ")}`);
  }

  const combinedGroups = new Map(
    [
      ...defaultGroups(),
      ...requestedIds.map((id) => groupById.get(id) as SkillGroup),
    ].map((group) => [group.id, group]),
  );
  return [...combinedGroups.values()];
}

async function promptForOptionalGroups(
  message: string,
  groupsToOffer: SkillGroup[],
): Promise<SkillGroup[]> {
  const selectedIds = assertNotCancelled(
    await multiselect<string>({
      message,
      options: groupsToOffer.map((group) => ({
        value: group.id,
        label: `${group.label} (${group.skills.length})`,
        hint: group.description,
      })),
      required: false,
      initialValues: [],
    }),
  );

  return groupsToOffer.filter((group) => selectedIds.includes(group.id));
}

export async function resolveGroupsForFreshInstall(
  ctx: Context,
  skillGroupsOption: string | undefined,
): Promise<SkillGroup[]> {
  if (skillGroupsOption !== undefined) {
    return resolveExplicitGroups(skillGroupsOption);
  }

  if (ctx.dryRun) {
    return defaultGroups();
  }

  if (ctx.yes) {
    return [...SKILL_GROUPS];
  }

  if (!ctx.interactive) {
    return defaultGroups();
  }

  const selected = await promptForOptionalGroups(
    "Optional skill groups to install",
    optionalGroups(),
  );

  return [...defaultGroups(), ...selected];
}
export async function resolveNewlyOfferedGroups(
  ctx: Context,
  groupsToOffer: SkillGroup[],
): Promise<SkillGroup[]> {
  if (groupsToOffer.length === 0 || ctx.dryRun || !ctx.interactive) {
    return [];
  }

  if (ctx.yes) {
    return groupsToOffer;
  }

  return promptForOptionalGroups(
    "New optional skill groups to install",
    groupsToOffer,
  );
}
