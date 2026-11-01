import { multiselect } from "@clack/prompts";
import type { Context } from "../../core/context.js";
import { assertNotCancelled } from "../../core/prompt-clack.js";
import { printable } from "../../core/untrusted-text.js";
import { SKILL_GROUPS, type SkillGroup } from "./catalog.js";

const ALL_GROUPS_KEYWORD = "all";
const NO_GROUPS_KEYWORD = "none";

export interface GroupSelection {
  chosen: SkillGroup[];
  offered: SkillGroup[];
}

function parseExplicitGroupIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function defaultGroups(): SkillGroup[] {
  return SKILL_GROUPS.filter((group) => group.defaultSelected);
}

function optionalGroups(customGroups: SkillGroup[]): SkillGroup[] {
  return [
    ...SKILL_GROUPS.filter((group) => !group.defaultSelected),
    ...customGroups,
  ];
}

function isKeyword(skillGroupsOption: string): boolean {
  const keyword = skillGroupsOption.trim().toLowerCase();
  return keyword === ALL_GROUPS_KEYWORD || keyword === NO_GROUPS_KEYWORD;
}

function resolveNamedGroups(
  skillGroupsOption: string,
  customGroups: SkillGroup[],
): SkillGroup[] {
  const groupById = new Map(
    [...SKILL_GROUPS, ...customGroups].map((group) => [group.id, group]),
  );
  const requestedIds = parseExplicitGroupIds(skillGroupsOption);
  const unknownIds = requestedIds.filter((id) => !groupById.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown skill group id(s): ${unknownIds.join(", ")}`);
  }
  return requestedIds.map((id) => groupById.get(id) as SkillGroup);
}

function resolveExplicitGroups(
  skillGroupsOption: string,
  customGroups: SkillGroup[],
): SkillGroup[] {
  const keyword = skillGroupsOption.trim().toLowerCase();
  if (keyword === NO_GROUPS_KEYWORD) {
    return defaultGroups();
  }
  if (keyword === ALL_GROUPS_KEYWORD) {
    return SKILL_GROUPS;
  }

  const combinedGroups = new Map(
    [
      ...defaultGroups(),
      ...resolveNamedGroups(skillGroupsOption, customGroups),
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
        label: `${printable(group.label)} (${group.skills.length})`,
        hint: group.description,
      })),
      required: false,
      initialValues: [],
    }),
  );

  return groupsToOffer.filter((group) => selectedIds.includes(group.id));
}

export async function selectGroupsForFreshInstall(
  ctx: Context,
  customGroups: SkillGroup[],
): Promise<GroupSelection> {
  if (ctx.skillGroupsOption !== undefined) {
    return {
      chosen: resolveExplicitGroups(ctx.skillGroupsOption, customGroups),
      offered: [],
    };
  }

  if (ctx.dryRun) {
    return { chosen: defaultGroups(), offered: [] };
  }

  if (ctx.yes) {
    return { chosen: [...SKILL_GROUPS], offered: [] };
  }

  if (!ctx.interactive) {
    return { chosen: defaultGroups(), offered: [] };
  }

  const groupsToOffer = optionalGroups(customGroups);
  const selected = await promptForOptionalGroups(
    "Optional skill groups to install",
    groupsToOffer,
  );
  return { chosen: [...defaultGroups(), ...selected], offered: groupsToOffer };
}

export async function selectNewlyOfferedGroups(
  ctx: Context,
  customGroups: SkillGroup[],
  unofferedGroups: SkillGroup[],
): Promise<GroupSelection> {
  const option = ctx.skillGroupsOption;
  const namedIds = new Set(
    option === undefined || isKeyword(option)
      ? []
      : resolveNamedGroups(option, customGroups).map((group) => group.id),
  );
  const named = unofferedGroups.filter((group) => namedIds.has(group.id));
  const remaining = unofferedGroups.filter((group) => !namedIds.has(group.id));
  const remainingBuiltIn = remaining.filter(
    (group) => !customGroups.includes(group),
  );

  if (remaining.length === 0 || ctx.dryRun) {
    return { chosen: named, offered: [] };
  }

  if (!ctx.interactive) {
    return { chosen: named, offered: ctx.yes ? remainingBuiltIn : [] };
  }

  if (ctx.yes) {
    return { chosen: [...named, ...remainingBuiltIn], offered: [] };
  }

  const selected = await promptForOptionalGroups(
    "New optional skill groups to install",
    remaining,
  );
  return { chosen: [...named, ...selected], offered: remaining };
}
