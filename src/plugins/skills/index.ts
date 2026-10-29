import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CUSTOM_SKILL_GROUP_RESOURCE_PREFIX } from "../../core/consent.js";
import type { Context } from "../../core/context.js";
import { readRegularFileIfExists } from "../../core/files.js";
import { fingerprintJson } from "../../core/fingerprint.js";
import { ensureGitignoreEntry } from "../../core/gitignore.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { withAgemonStateLock } from "../../core/state-root.js";
import { printable } from "../../core/untrusted-text.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
} from "../types.js";
import {
  buildCustomSkillGroups,
  SKILL_GROUPS,
  type SkillBundleEntry,
  type SkillGroup,
} from "./catalog.js";
import {
  type GroupSelection,
  selectGroupsForFreshInstall,
  selectNewlyOfferedGroups,
} from "./group-selection.js";
import {
  readLocalSkill,
  withSkillsStage,
  writeStagedSkill,
} from "./local-source.js";
import {
  fetchPinnedSkillsSource,
  type PinnedSkillsRepository,
  resolvePinnedSkillPath,
} from "./pinned-source.js";
import { assertSkillManifestName } from "./skill-manifest.js";
import { runSkillsCli } from "./skills-cli.js";
import {
  assertSkillsCliTargetsStayInRepo,
  removeLeftoverCanonicalSkill,
  SKILLS_LOCK_FILE,
} from "./skills-cli-targets.js";

const PLUGIN_ID = "skills";

const ACTION_TYPE_INSTALLED_SKILL = "installed-skill";
const ACTION_TYPE_PREEXISTING_SKILL = "preexisting-skill";
const ACTION_TYPE_GENERATED_SKILLS_LOCK = "generated-skills-lock";
const ACTION_TYPE_OFFERED_SKILL_GROUP = "offered-skill-group";
const ACTION_TYPE_DECLINED_SKILL_GROUP = "declined-skill-group";
const SKILL_GROUP_RESOURCE_PREFIX = "skill-group:";
const BUILT_IN_SOURCE_DESCRIPTION = "bundled with agemon";
const DECLINED_GROUP_PREVIEW = "declined — agemon will not offer it again";
const SKILL_MANIFEST_PATH = "SKILL.md";
const SKILLS_LOCK_GITIGNORE_ENTRY = "/skills-lock.json";

const SKILLS_LIST_TIMEOUT_MS = 30_000;
const SKILLS_ADD_TIMEOUT_MS = 180_000;
const SKILLS_SOURCE_LOCK_WAIT_MS = 30 * 60_000;
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

function getCustomGroups(ctx: Context): SkillGroup[] {
  return buildCustomSkillGroups(ctx.customSkillGroups ?? []);
}

function getAvailableGroups(ctx: Context): SkillGroup[] {
  return [...SKILL_GROUPS, ...getCustomGroups(ctx)];
}

const SKILL_RECORD_TYPES: ReadonlySet<string> = new Set([
  ACTION_TYPE_INSTALLED_SKILL,
  ACTION_TYPE_PREEXISTING_SKILL,
]);

function getRecordedGroups(ctx: Context): SkillGroup[] {
  const recordedSkillNames = new Set(
    getPluginActions(ctx)
      .filter((action) => SKILL_RECORD_TYPES.has(action.type))
      .map((action) => action.target),
  );
  return getAvailableGroups(ctx).filter((group) =>
    group.skills.some((skill) => recordedSkillNames.has(skill.skillName)),
  );
}
function getOfferedGroupIds(ctx: Context): Set<string> {
  return new Set(
    getPluginActions(ctx)
      .filter((action) => action.type === ACTION_TYPE_OFFERED_SKILL_GROUP)
      .map((action) => action.target),
  );
}

function getUnofferedGroups(ctx: Context): SkillGroup[] {
  const decidedGroupIds = new Set(getRecordedGroups(ctx).map((g) => g.id));
  const offeredGroupIds = getOfferedGroupIds(ctx);
  return getAvailableGroups(ctx).filter(
    (group) => !offeredGroupIds.has(group.id) && !decidedGroupIds.has(group.id),
  );
}

function getDeclinedGroupIds(ctx: Context): Set<string> {
  return new Set(
    getPluginActions(ctx)
      .filter((action) => action.type === ACTION_TYPE_DECLINED_SKILL_GROUP)
      .map((action) => action.target),
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
  const listResult = await runSkillsCli(
    ctx,
    ["list", "--json"],
    SKILLS_LIST_TIMEOUT_MS,
  );
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr || "skills list failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listResult.stdout || "[]");
  } catch {
    const stderr = listResult.stderr.trim();
    const stdoutPreview = listResult.stdout.trim().slice(0, 200);
    const detail = stderr || stdoutPreview || "no command output";
    throw new Error(`skills list returned invalid JSON: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("skills list returned non-array JSON");
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
  return { present: true, preExisting: !allManaged };
}

function getReportableGroups(ctx: Context): SkillGroup[] {
  const recordedGroups = getRecordedGroups(ctx);
  const declinedGroupIds = getDeclinedGroupIds(ctx);
  const combinedGroups = new Map(
    recordedGroups.map((group) => [group.id, group]),
  );
  for (const group of getAvailableGroups(ctx)) {
    if (declinedGroupIds.has(group.id)) {
      combinedGroups.set(group.id, group);
    }
  }
  return [...combinedGroups.values()];
}

async function describeSkillsState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const reportableGroups = getReportableGroups(ctx);
  if (reportableGroups.length === 0) {
    return [
      {
        capabilityId: PLUGIN_ID,
        resourceId: "skill-groups:none",
        label: "skill groups",
        state: "absent",
        detail: null,
      },
    ];
  }

  let installedSkillNames: Set<string>;
  try {
    installedSkillNames = await listInstalledSkillNames(ctx);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "skills list failed";
    return reportableGroups.map((group) => ({
      capabilityId: PLUGIN_ID,
      resourceId: groupResourceId(group),
      label: group.label,
      state: "unknown" as const,
      detail,
    }));
  }

  const declinedGroupIds = getDeclinedGroupIds(ctx);

  return reportableGroups.map((group): CapabilityStateRow => {
    const resourceId = groupResourceId(group);
    const installedCount = group.skills.filter((skill) =>
      installedSkillNames.has(skill.skillName),
    ).length;

    if (installedCount < group.skills.length) {
      return {
        capabilityId: PLUGIN_ID,
        resourceId,
        label: group.label,
        state:
          installedCount === 0 && declinedGroupIds.has(group.id)
            ? "declined"
            : "absent",
        detail: `${installedCount}/${group.skills.length} skills installed`,
      };
    }

    const allManaged = group.skills.every((skill) =>
      hasManagedInstallRecord(ctx, skill.skillName),
    );
    return {
      capabilityId: PLUGIN_ID,
      resourceId,
      label: group.label,
      state: allManaged ? "present-managed" : "present-adopted",
      detail: `${group.skills.length} skill(s)`,
    };
  });
}

function describeSkillSource(entry: SkillBundleEntry): string {
  if (entry.pinnedRepository) {
    return `${entry.pinnedRepository.url} at ${entry.pinnedRepository.commit}`;
  }
  return entry.localSourcePath ?? BUILT_IN_SOURCE_DESCRIPTION;
}

async function fingerprintLocalSkills(
  ctx: Context,
  group: SkillGroup,
): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  for (const entry of group.skills) {
    if (entry.localSourcePath !== undefined) {
      const localSkill = await readLocalSkill(
        ctx.cwd,
        entry.localSourcePath,
        entry.skillName,
      );
      fingerprints.set(entry.skillName, localSkill.fingerprint);
    }
  }
  return fingerprints;
}

function combineLocalFingerprints(
  fingerprints: Map<string, string>,
): string | null {
  return fingerprints.size === 0
    ? null
    : fingerprintJson([...fingerprints.entries()]);
}

function groupResourceId(group: SkillGroup): string {
  return `${
    group.definedByRepository
      ? CUSTOM_SKILL_GROUP_RESOURCE_PREFIX
      : SKILL_GROUP_RESOURCE_PREFIX
  }${group.id}`;
}

async function describeGroupInstall(
  ctx: Context,
  group: SkillGroup,
): Promise<ProposedOperation> {
  const localFingerprints = await fingerprintLocalSkills(ctx, group);
  const skillLines = group.skills.map((entry) => {
    const localFingerprint = localFingerprints.get(entry.skillName);
    const contentNote =
      localFingerprint === undefined
        ? ""
        : ` in this repository, content sha256 ${localFingerprint.slice(0, 16)}`;
    return `${entry.skillName} — ${describeSkillSource(entry)}${contentNote}`;
  });
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: groupResourceId(group),
    targetPath: "",
    action: "install-package",
    riskClass: "executes",
    requiresConsent: true,
    expectedFingerprint: combineLocalFingerprints(localFingerprints),
    preview: {
      kind: "note",
      text: [`${group.label}:`, ...skillLines].join("\n"),
    },
  });
}

function describeGroupDecline(group: SkillGroup): ProposedOperation {
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: groupResourceId(group),
    targetPath: "",
    action: "skip",
    riskClass: "inert",
    requiresConsent: true,
    preview: { kind: "note", text: DECLINED_GROUP_PREVIEW },
  });
}

async function findGroupsMissingSkills(
  ctx: Context,
  recordedGroups: SkillGroup[],
): Promise<SkillGroup[]> {
  if (recordedGroups.length === 0) {
    return [];
  }
  const installedSkillNames = await listInstalledSkillNames(ctx);
  return recordedGroups.filter((group) =>
    group.skills.some((entry) => !installedSkillNames.has(entry.skillName)),
  );
}

function selectGroups(
  ctx: Context,
  recordedGroups: SkillGroup[],
): Promise<GroupSelection> {
  const customGroups = getCustomGroups(ctx);
  return recordedGroups.length === 0
    ? selectGroupsForFreshInstall(ctx, customGroups)
    : selectNewlyOfferedGroups(ctx, customGroups, getUnofferedGroups(ctx));
}

async function planSkills(ctx: Context): Promise<ProposedOperation[]> {
  const recordedGroups = getRecordedGroups(ctx);
  const selection = await selectGroups(ctx, recordedGroups);
  const groupIdsToInstall = new Set(
    [
      ...(await findGroupsMissingSkills(ctx, recordedGroups)),
      ...selection.chosen,
    ].map((group) => group.id),
  );
  const availableGroups = getAvailableGroups(ctx);
  const groupsToInstall = availableGroups.filter((group) =>
    groupIdsToInstall.has(group.id),
  );
  const declinedGroups = selection.offered.filter(
    (group) => !groupIdsToInstall.has(group.id),
  );

  const operations: ProposedOperation[] = [];
  for (const group of groupsToInstall) {
    operations.push(await describeGroupInstall(ctx, group));
  }
  operations.push(...declinedGroups.map(describeGroupDecline));
  return operations;
}

async function recordDeclinedGroups(
  ctx: Context,
  declinedGroups: SkillGroup[],
): Promise<void> {
  for (const group of declinedGroups) {
    for (const type of [
      ACTION_TYPE_OFFERED_SKILL_GROUP,
      ACTION_TYPE_DECLINED_SKILL_GROUP,
    ]) {
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type,
        target: group.id,
        preExisting: false,
      });
    }
  }
}

async function fetchPinnedSources(
  ctx: Context,
  entries: SkillBundleEntry[],
): Promise<void> {
  const fetchesByCommit = new Map<
    string,
    { repository: PinnedSkillsRepository; skillNames: string[] }
  >();
  for (const { pinnedRepository, skillName } of entries) {
    if (pinnedRepository) {
      const pendingFetch = fetchesByCommit.get(pinnedRepository.commit) ?? {
        repository: pinnedRepository,
        skillNames: [],
      };
      pendingFetch.skillNames.push(skillName);
      fetchesByCommit.set(pinnedRepository.commit, pendingFetch);
    }
  }
  for (const { repository, skillNames } of fetchesByCommit.values()) {
    await fetchPinnedSkillsSource(ctx, repository, skillNames);
  }
}

async function assertFetchedSkillNames(
  entries: SkillBundleEntry[],
): Promise<void> {
  for (const { pinnedRepository, skillName } of entries) {
    if (pinnedRepository) {
      const manifest = await readRegularFileIfExists(
        join(
          resolvePinnedSkillPath(pinnedRepository, skillName),
          SKILL_MANIFEST_PATH,
        ),
      );
      assertSkillManifestName(
        manifest ?? "",
        skillName,
        `${pinnedRepository.url} at ${pinnedRepository.commit}`,
      );
    }
  }
}

interface GroupInstall {
  group: SkillGroup;
  operation: ProposedOperation;
}

async function stageLocalSkills(
  ctx: Context,
  stageDirectory: string,
  { group, operation }: GroupInstall,
): Promise<Map<string, string>> {
  const stagedPaths = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  for (const entry of group.skills) {
    if (entry.localSourcePath !== undefined) {
      const localSkill = await readLocalSkill(
        ctx.cwd,
        entry.localSourcePath,
        entry.skillName,
      );
      fingerprints.set(entry.skillName, localSkill.fingerprint);
      stagedPaths.set(
        entry.skillName,
        await writeStagedSkill(stageDirectory, entry.skillName, localSkill),
      );
    }
  }
  if (
    combineLocalFingerprints(fingerprints) !== operation.expectedFingerprint
  ) {
    throw new Error(
      `The custom skill group '${group.id}' changed since it was planned. Re-run 'agemon plan' and review it again.`,
    );
  }
  return stagedPaths;
}

async function addSkills(
  ctx: Context,
  entriesToAdd: SkillBundleEntry[],
  stagedPaths: Map<string, string>,
): Promise<void> {
  await fetchPinnedSources(ctx, entriesToAdd);
  await assertFetchedSkillNames(
    entriesToAdd.filter((entry) => customSkillNames(ctx).has(entry.skillName)),
  );
  await assertSkillsCliTargetsStayInRepo(
    ctx.cwd,
    entriesToAdd.map((entry) => entry.skillName),
    { create: true },
  );
  for (const entry of entriesToAdd) {
    const addResult = await runSkillsCli(
      ctx,
      [
        "add",
        stagedPaths.get(entry.skillName) ?? entry.source,
        "--skill",
        entry.skillName,
        "--agent",
        entry.agent,
        "--yes",
      ],
      SKILLS_ADD_TIMEOUT_MS,
    );
    if (addResult.code !== 0) {
      throw new Error(
        addResult.stderr || `skills add failed for ${entry.skillName}`,
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

function customSkillNames(ctx: Context): Set<string> {
  return new Set(
    flattenSkills(getCustomGroups(ctx)).map((entry) => entry.skillName),
  );
}

async function installGroups(
  ctx: Context,
  groupInstalls: GroupInstall[],
  stageDirectory: string,
): Promise<void> {
  const stagedPaths = new Map<string, string>();
  for (const groupInstall of groupInstalls) {
    for (const [skillName, path] of await stageLocalSkills(
      ctx,
      stageDirectory,
      groupInstall,
    )) {
      stagedPaths.set(skillName, path);
    }
  }

  const skillsLockPreviouslyExisted = existsSync(getSkillsLockPath(ctx.cwd));
  const installedSkillNames = await listInstalledSkillNames(ctx);
  const entriesToAdd: SkillBundleEntry[] = [];
  for (const entry of flattenSkills(groupInstalls.map(({ group }) => group))) {
    if (!installedSkillNames.has(entry.skillName)) {
      entriesToAdd.push(entry);
    } else if (!hasAnyRecordForSkill(ctx, entry.skillName)) {
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_PREEXISTING_SKILL,
        target: entry.skillName,
        preExisting: true,
      });
    }
  }

  await withAgemonStateLock(
    "skills-src.lock",
    () => addSkills(ctx, entriesToAdd, stagedPaths),
    SKILLS_SOURCE_LOCK_WAIT_MS,
  );

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
    await ensureGitignoreEntry(ctx.cwd, SKILLS_LOCK_GITIGNORE_ENTRY);
  }
}

function findOperationGroup(
  availableGroups: SkillGroup[],
  operation: ProposedOperation,
): SkillGroup {
  const group = availableGroups.find(
    (candidate) => groupResourceId(candidate) === operation.resourceId,
  );
  if (group === undefined) {
    throw new Error(
      `The plan names skill group resource '${printable(operation.resourceId)}', which agemon does not know. Re-run 'agemon plan'.`,
    );
  }
  return group;
}

async function applySkills(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<void> {
  const availableGroups = getAvailableGroups(ctx);
  const groupInstalls: GroupInstall[] = [];
  const declinedGroups: SkillGroup[] = [];
  for (const operation of operations) {
    const group = findOperationGroup(availableGroups, operation);
    if (operation.action === "install-package") {
      groupInstalls.push({ group, operation });
    } else if (operation.action === "skip") {
      declinedGroups.push(group);
    } else {
      throw new Error(
        `The skills capability does not ${operation.action} '${printable(operation.resourceId)}'.`,
      );
    }
  }

  await recordDeclinedGroups(ctx, declinedGroups);
  if (groupInstalls.length > 0) {
    await withSkillsStage((stageDirectory) =>
      installGroups(ctx, groupInstalls, stageDirectory),
    );
  }
}

async function installSkills(ctx: Context): Promise<void> {
  await applySkills(ctx, await planSkills(ctx));
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

async function revertSkills(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  const managedActions = entries.filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.preExisting === false,
  );
  const shouldRemoveManagedSkillsLock = entries.some(
    (action) =>
      action.type === ACTION_TYPE_GENERATED_SKILLS_LOCK &&
      action.target === SKILLS_LOCK_FILE &&
      action.preExisting === false,
  );

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
      ctx.ui.info(`Would remove skill ${printable(action.target)}`);
    }
    if (shouldRemoveManagedSkillsLock) {
      ctx.ui.info(`Would remove ${SKILLS_LOCK_FILE}`);
    }
    return;
  }

  const installedSkillNames = await listInstalledSkillNames(ctx);
  const skillNamesToRemove = managedActions
    .map((action) => action.target)
    .filter((skillName) => installedSkillNames.has(skillName));
  await assertSkillsCliTargetsStayInRepo(ctx.cwd, skillNamesToRemove, {
    create: false,
  });
  for (const skillName of skillNamesToRemove) {
    const removeResult = await runSkillsCli(
      ctx,
      ["remove", skillName, "--agent", "claude-code", "--yes"],
      SKILLS_REMOVE_TIMEOUT_MS,
    );
    if (removeResult.code !== 0) {
      throw new Error(
        removeResult.stderr ||
          `skills remove failed for ${printable(skillName)}`,
      );
    }
    await removeLeftoverCanonicalSkill(ctx.cwd, skillName);
  }

  if (shouldRemoveManagedSkillsLock) {
    await rm(getSkillsLockPath(ctx.cwd), { force: true });
  }
}

async function uninstallSkills(ctx: Context): Promise<void> {
  await revertSkills(ctx, getPluginActions(ctx));
}

export const skillsPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "executes",
  detect: detectSkills,
  describeState: describeSkillsState,
  plan: planSkills,
  apply: applySkills,
  install: installSkills,
  verify: verifySkills,
  revert: revertSkills,
  uninstall: uninstallSkills,
};
