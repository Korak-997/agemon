import type { Context } from "../../core/context.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { findSkillGroup, SKILL_GROUPS } from "./catalog.js";

export const SKILLS_PLUGIN_ID = "skills";
export const SKILL_GROUP_RESOURCE_PREFIX = "skill-group:";
export const ACTION_TYPE_INSTALLED_SKILL = "installed-skill";
export const ACTION_TYPE_PREEXISTING_SKILL = "preexisting-skill";
export const ACTION_TYPE_DECLINED_SKILL_GROUP = "declined-skill-group";

const SKILL_RECORD_TYPES: ReadonlySet<string> = new Set([
  ACTION_TYPE_INSTALLED_SKILL,
  ACTION_TYPE_PREEXISTING_SKILL,
]);

export function skillsLedgerEntries(ctx: Context): LedgerEntry[] {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === SKILLS_PLUGIN_ID);
}

function skillNamesIn(entries: LedgerEntry[]): Set<string> {
  return new Set(
    entries
      .filter((action) => SKILL_RECORD_TYPES.has(action.type))
      .map((action) => action.target),
  );
}

export function recordedSkillNames(ctx: Context): Set<string> {
  return skillNamesIn(skillsLedgerEntries(ctx));
}

export function confirmedRecordedSkillNames(ctx: Context): Set<string> {
  return skillNamesIn(
    skillsLedgerEntries(ctx).filter((action) =>
      ctx.manifest.isConfirmed(action),
    ),
  );
}

export function declinedSkillGroupIds(ctx: Context): Set<string> {
  return new Set(
    skillsLedgerEntries(ctx)
      .filter((action) => action.type === ACTION_TYPE_DECLINED_SKILL_GROUP)
      .map((action) => action.target),
  );
}

export function recordedBuiltInGroupIds(ctx: Context): Set<string> {
  const skillNames = recordedSkillNames(ctx);
  const declinedIds = declinedSkillGroupIds(ctx);
  return new Set(
    SKILL_GROUPS.filter(
      (group) =>
        !declinedIds.has(group.id) &&
        group.skills.some((skill) => skillNames.has(skill.skillName)),
    ).map((group) => group.id),
  );
}

export function builtInGroupIdFromResource(resourceId: string): string | null {
  if (!resourceId.startsWith(SKILL_GROUP_RESOURCE_PREFIX)) {
    return null;
  }
  const groupId = resourceId.slice(SKILL_GROUP_RESOURCE_PREFIX.length);
  return findSkillGroup(groupId) === undefined ? null : groupId;
}
