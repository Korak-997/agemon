import type { Context } from "../../core/context.js";
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

/**
 * Resolves which skill groups a fresh bootstrap should install:
 * - `--skill-groups all` / `none` / a comma-separated id list — explicit,
 *   non-interactive, works the same with or without a TTY.
 * - flag omitted, interactive session — asks once per optional group via
 *   `ctx.confirm`, on top of the always-on default groups.
 * - flag omitted, dry-run or non-interactive session (CI, no TTY) — only the
 *   default groups, matching `ctx.confirm`'s existing "decline when nobody's
 *   there to ask" policy. Pass `--skill-groups` explicitly to preview or
 *   install optional groups without a prompt.
 */
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

  const selectedOptionalGroups: SkillGroup[] = [];
  for (const group of optionalGroups()) {
    const shouldInstall = await ctx.confirm(
      `Install '${group.label}' skills (${group.skills.length})? — ${group.description}`,
    );
    if (shouldInstall) {
      selectedOptionalGroups.push(group);
    }
  }

  return [...defaultGroups(), ...selectedOptionalGroups];
}
