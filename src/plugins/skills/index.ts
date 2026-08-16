import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";
import {
  SKILL_GROUPS,
  type SkillBundleEntry,
  type SkillGroup,
} from "./catalog.js";
import { resolveGroupsForFreshInstall } from "./group-selection.js";

const PLUGIN_ID = "skills";

const ACTION_TYPE_INSTALLED_SKILL = "installed-skill";
const ACTION_TYPE_PREEXISTING_SKILL = "preexisting-skill";
const ACTION_TYPE_GENERATED_SKILLS_LOCK = "generated-skills-lock";
const SKILLS_LOCK_FILE = "skills-lock.json";

const SKILLS_LIST_TIMEOUT_MS = 30_000;
const SKILLS_ADD_TIMEOUT_MS = 180_000;
const SKILLS_REMOVE_TIMEOUT_MS = 120_000;

interface SkillsListEntry {
  name: string;
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function flattenSkills(groups: SkillGroup[]): SkillBundleEntry[] {
  return groups.flatMap((group) => group.skills);
}

/**
 * Which groups this repo has already engaged with, derived from the
 * manifest rather than re-asked — a group counts as "recorded" once any one
 * of its skills has a managed or preexisting record.
 */
function getRecordedGroups(ctx: Context): SkillGroup[] {
  const recordedSkillNames = new Set(
    getPluginActions(ctx).map((action) => action.target),
  );
  return SKILL_GROUPS.filter((group) =>
    group.skills.some((skill) => recordedSkillNames.has(skill.skillName)),
  );
}

function hasManagedInstallRecord(ctx: Context, skillName: string): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.target === skillName &&
      action.preExisting === false,
  );
}

function hasPreexistingRecord(ctx: Context, skillName: string): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_PREEXISTING_SKILL &&
      action.target === skillName &&
      action.preExisting === true,
  );
}

function hasAnyRecordForSkill(ctx: Context, skillName: string): boolean {
  return (
    hasManagedInstallRecord(ctx, skillName) ||
    hasPreexistingRecord(ctx, skillName)
  );
}

function getSkillsLockPath(cwd: string): string {
  return join(cwd, SKILLS_LOCK_FILE);
}

function hasManagedSkillsLockRecord(ctx: Context): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_GENERATED_SKILLS_LOCK &&
      action.target === SKILLS_LOCK_FILE &&
      action.preExisting === false,
  );
}

async function listInstalledSkillNames(ctx: Context): Promise<Set<string>> {
  const listResult = await ctx.run("npx", ["skills", "list", "--json"], {
    timeoutMs: SKILLS_LIST_TIMEOUT_MS,
  });
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr || "npx skills list failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listResult.stdout || "[]");
  } catch {
    const stderr = listResult.stderr.trim();
    const stdoutPreview = listResult.stdout.trim().slice(0, 200);
    const detail = stderr || stdoutPreview || "no command output";
    throw new Error(`npx skills list returned invalid JSON: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("npx skills list returned non-array JSON");
  }

  const installedSkillNames = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typedItem = item as SkillsListEntry;
    if (typeof typedItem.name === "string" && typedItem.name.length > 0) {
      installedSkillNames.add(typedItem.name);
    }
  }

  return installedSkillNames;
}

async function detectSkills(ctx: Context): Promise<PluginPresence> {
  const recordedGroups = getRecordedGroups(ctx);
  if (recordedGroups.length === 0) {
    return { present: false, preExisting: false };
  }

  const recordedEntries = flattenSkills(recordedGroups);
  const installedSkillNames = await listInstalledSkillNames(ctx);
  const allRecordedSkillsPresent = recordedEntries.every((entry) =>
    installedSkillNames.has(entry.skillName),
  );
  if (!allRecordedSkillsPresent) {
    return { present: false, preExisting: false };
  }

  const allManaged = recordedEntries.every((entry) =>
    hasManagedInstallRecord(ctx, entry.skillName),
  );
  if (allManaged) {
    return { present: true, preExisting: false };
  }

  if (!ctx.dryRun) {
    for (const entry of recordedEntries) {
      if (hasAnyRecordForSkill(ctx, entry.skillName)) {
        continue;
      }
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_PREEXISTING_SKILL,
        target: entry.skillName,
        preExisting: true,
      });
    }
  }

  return { present: true, preExisting: true };
}

async function installSkills(ctx: Context): Promise<void> {
  const groupsToInstall = await resolveGroupsForFreshInstall(
    ctx,
    ctx.skillGroupsOption,
  );
  const entriesToInstall = flattenSkills(groupsToInstall);

  if (ctx.dryRun) {
    for (const entry of entriesToInstall) {
      ctx.ui.info(`Would add skill ${entry.skillName} from ${entry.source}`);
    }
    return;
  }

  const skillsLockPreviouslyExisted = existsSync(getSkillsLockPath(ctx.cwd));
  const installedSkillNames = await listInstalledSkillNames(ctx);
  for (const entry of entriesToInstall) {
    if (installedSkillNames.has(entry.skillName)) {
      if (!hasAnyRecordForSkill(ctx, entry.skillName)) {
        await ctx.manifest.recordAction({
          plugin: PLUGIN_ID,
          type: ACTION_TYPE_PREEXISTING_SKILL,
          target: entry.skillName,
          preExisting: true,
        });
      }
      continue;
    }

    const addResult = await ctx.run(
      "npx",
      [
        "skills",
        "add",
        entry.source,
        "--skill",
        entry.skillName,
        "--agent",
        entry.agent,
        "--yes",
      ],
      {
        timeoutMs: SKILLS_ADD_TIMEOUT_MS,
      },
    );
    if (addResult.code !== 0) {
      throw new Error(
        addResult.stderr || `npx skills add failed for ${entry.skillName}`,
      );
    }

    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_INSTALLED_SKILL,
      target: entry.skillName,
      preExisting: false,
    });
  }

  const skillsLockExistsAfterInstall = existsSync(getSkillsLockPath(ctx.cwd));
  if (
    !skillsLockPreviouslyExisted &&
    skillsLockExistsAfterInstall &&
    !hasManagedSkillsLockRecord(ctx)
  ) {
    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_GENERATED_SKILLS_LOCK,
      target: SKILLS_LOCK_FILE,
      preExisting: false,
    });
  }
}

async function verifySkills(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const recordedGroups = getRecordedGroups(ctx);
  const recordedEntries = flattenSkills(recordedGroups);
  if (recordedEntries.length === 0) {
    return { ok: false, detail: "No skill groups installed yet" };
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  const missingSkillNames = recordedEntries
    .map((entry) => entry.skillName)
    .filter((skillName) => !installedSkillNames.has(skillName));

  if (missingSkillNames.length > 0) {
    return {
      ok: false,
      detail: `Missing skill(s): ${missingSkillNames.join(", ")}`,
    };
  }

  return {
    ok: true,
    detail: `${recordedGroups.length} skill group(s), ${recordedEntries.length} skill(s) present`,
  };
}

async function uninstallSkills(ctx: Context): Promise<void> {
  const managedActions = getPluginActions(ctx).filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.preExisting === false,
  );
  const shouldRemoveManagedSkillsLock = hasManagedSkillsLockRecord(ctx);

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      if (shouldRemoveManagedSkillsLock) {
        ctx.ui.info(`Would remove ${SKILLS_LOCK_FILE}`);
      } else {
        ctx.ui.info("Would keep pre-existing skills untouched");
      }
      return;
    }
    for (const action of managedActions) {
      ctx.ui.info(`Would remove skill ${action.target}`);
    }
    if (shouldRemoveManagedSkillsLock) {
      ctx.ui.info(`Would remove ${SKILLS_LOCK_FILE}`);
    }
    return;
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  for (const action of managedActions) {
    if (!installedSkillNames.has(action.target)) {
      continue;
    }

    const removeResult = await ctx.run(
      "npx",
      ["skills", "remove", action.target, "--yes"],
      {
        timeoutMs: SKILLS_REMOVE_TIMEOUT_MS,
      },
    );
    if (removeResult.code !== 0) {
      throw new Error(
        removeResult.stderr || `npx skills remove failed for ${action.target}`,
      );
    }
  }

  if (shouldRemoveManagedSkillsLock) {
    await rm(getSkillsLockPath(ctx.cwd), { force: true });
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const skillsPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  detect: detectSkills,
  install: installSkills,
  verify: verifySkills,
  uninstall: uninstallSkills,
};
