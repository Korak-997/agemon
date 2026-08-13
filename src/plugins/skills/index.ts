import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";
import { SKILL_BUNDLE } from "./catalog.js";

const PLUGIN_ID = "skills";

const ACTION_TYPE_INSTALLED_SKILL = "installed-skill";
const ACTION_TYPE_PREEXISTING_SKILL = "preexisting-skill";

interface SkillsListEntry {
  name: string;
}

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
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
  return hasManagedInstallRecord(ctx, skillName) || hasPreexistingRecord(ctx, skillName);
}

async function listInstalledSkillNames(ctx: Context): Promise<Set<string>> {
  const listResult = await ctx.run("npx", ["skills", "list", "--json"]);
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr || "npx skills list failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listResult.stdout || "[]");
  } catch {
    throw new Error("npx skills list returned invalid JSON");
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

function allBundleSkillsPresent(installedSkillNames: Set<string>): boolean {
  return SKILL_BUNDLE.every((entry) => installedSkillNames.has(entry.skillName));
}

async function detectSkills(ctx: Context): Promise<PluginPresence> {
  const installedSkillNames = await listInstalledSkillNames(ctx);
  if (!allBundleSkillsPresent(installedSkillNames)) {
    return { present: false, preExisting: false };
  }

  const allManaged = SKILL_BUNDLE.every((entry) =>
    hasManagedInstallRecord(ctx, entry.skillName),
  );
  if (allManaged) {
    return { present: true, preExisting: false };
  }

  if (!ctx.dryRun) {
    for (const entry of SKILL_BUNDLE) {
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
  if (ctx.dryRun) {
    for (const entry of SKILL_BUNDLE) {
      ctx.ui.info(`Would add skill ${entry.skillName} from ${entry.source}`);
    }
    return;
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  for (const entry of SKILL_BUNDLE) {
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

    const addResult = await ctx.run("npx", [
      "skills",
      "add",
      entry.source,
      "--skill",
      entry.skillName,
      "--agent",
      entry.agent,
      "--yes",
    ]);
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
}

async function verifySkills(ctx: Context): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  const missingSkillNames = SKILL_BUNDLE.map((entry) => entry.skillName).filter(
    (skillName) => !installedSkillNames.has(skillName),
  );

  if (missingSkillNames.length > 0) {
    return {
      ok: false,
      detail: `Missing skill(s): ${missingSkillNames.join(", ")}`,
    };
  }

  return {
    ok: true,
    detail: `${SKILL_BUNDLE.length} skill bundle entries present`,
  };
}

async function uninstallSkills(ctx: Context): Promise<void> {
  const managedActions = getPluginActions(ctx).filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL && action.preExisting === false,
  );

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep pre-existing skills untouched");
      return;
    }
    for (const action of managedActions) {
      ctx.ui.info(`Would remove skill ${action.target}`);
    }
    return;
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  for (const action of managedActions) {
    if (!installedSkillNames.has(action.target)) {
      continue;
    }

    const removeResult = await ctx.run("npx", [
      "skills",
      "remove",
      action.target,
      "--yes",
    ]);
    if (removeResult.code !== 0) {
      throw new Error(
        removeResult.stderr || `npx skills remove failed for ${action.target}`,
      );
    }
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
