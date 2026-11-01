import { existsSync } from "node:fs";
import { join } from "node:path";
import { isPlainSkillName } from "../../core/config.js";
import { CUSTOM_SKILL_GROUP_RESOURCE_PREFIX } from "../../core/consent.js";
import type { Context } from "../../core/context.js";
import { RefusedPathError, readRegularFileIfExists } from "../../core/files.js";
import { fingerprintJson } from "../../core/fingerprint.js";
import { ensureGitignoreEntry } from "../../core/gitignore.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { withAgemonStateLock } from "../../core/state-root.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";
import { printable } from "../../core/untrusted-text.js";
import { describeOperation } from "../proposed-operation.js";
import type {
  AgemonPlugin,
  CapabilityState,
  CapabilityStateRow,
  PluginPresence,
  PluginVerificationResult,
  ProposedOperation,
  SkillUpdate,
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
  ACTION_TYPE_DECLINED_SKILL_GROUP,
  ACTION_TYPE_INSTALLED_SKILL,
  ACTION_TYPE_PREEXISTING_SKILL,
  confirmedRecordedSkillNames,
  declinedSkillGroupIds,
  recordedSkillNames,
  SKILL_GROUP_RESOURCE_PREFIX,
  SKILLS_PLUGIN_ID,
  skillsLedgerEntries,
} from "./ledger-view.js";
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
import {
  removeAgemonSkillCopy,
  removeSkillsFromLock,
  reportLeftCanonicalCopy,
} from "./skill-removal.js";
import {
  classifyInstalledSkill,
  classifyInstalledSkillForReport,
  currentSkillFingerprint,
  fingerprintsAgemonInstalled,
  forgetSkillClassifications,
  installedSkillFingerprint,
  shippedFingerprints,
  verifiedCustomInstallFingerprint,
} from "./skill-revisions.js";
import { runSkillsCli } from "./skills-cli.js";
import {
  assertSkillsCliTargetsStayInRepo,
  CANONICAL_SKILLS_DIRECTORY,
  CLAUDE_SKILLS_DIRECTORY,
  removeInstalledSkillCopy,
  SKILLS_LOCK_FILE,
} from "./skills-cli-targets.js";

const PLUGIN_ID = SKILLS_PLUGIN_ID;

const ACTION_TYPE_GENERATED_SKILLS_LOCK = "generated-skills-lock";
const ACTION_TYPE_OFFERED_SKILL_GROUP = "offered-skill-group";
const BUILT_IN_SOURCE_DESCRIPTION = "bundled with agemon";
const DECLINED_GROUP_PREVIEW = "declined — agemon will not offer it again";
const SKILL_MANIFEST_PATH = "SKILL.md";
const SKILLS_LOCK_GITIGNORE_ENTRY = "/skills-lock.json";
const ORPHANED_SKILLS_RESOURCE_ID = "skill-groups:orphaned";
const UPDATE_PREVIEW_NOTE = " — update (bundled content changed)";

const SKILLS_LIST_TIMEOUT_MS = 30_000;
const SKILLS_ADD_TIMEOUT_MS = 180_000;
const SKILLS_SOURCE_LOCK_WAIT_MS = 30 * 60_000;

interface SkillsListEntry {
  name: string;
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

function getRecordedGroups(ctx: Context): SkillGroup[] {
  const skillNames = recordedSkillNames(ctx);
  const confirmedSkillNames = confirmedRecordedSkillNames(ctx);
  return getAvailableGroups(ctx).filter((group) => {
    const namesThatCount = group.definedByRepository
      ? confirmedSkillNames
      : skillNames;
    return group.skills.some((skill) => namesThatCount.has(skill.skillName));
  });
}
function getOfferedGroupIds(ctx: Context): Set<string> {
  return new Set(
    skillsLedgerEntries(ctx)
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

function hasManagedInstallRecord(ctx: Context, skillName: string): boolean {
  return skillsLedgerEntries(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.target === skillName &&
      action.preExisting === false,
  );
}

function hasPreexistingRecord(ctx: Context, skillName: string): boolean {
  return skillsLedgerEntries(ctx).some(
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

function isManagedSkillsLockEntry(action: LedgerEntry): boolean {
  return (
    action.type === ACTION_TYPE_GENERATED_SKILLS_LOCK &&
    action.target === SKILLS_LOCK_FILE &&
    action.preExisting === false
  );
}

function hasManagedSkillsLockRecord(ctx: Context): boolean {
  return skillsLedgerEntries(ctx).some(
    (action) =>
      isManagedSkillsLockEntry(action) && ctx.manifest.isConfirmed(action),
  );
}

async function listInstalledSkillNames(ctx: Context): Promise<Set<string>> {
  const listResult = await runSkillsCli(
    ctx,
    ["list", "--json"],
    SKILLS_LIST_TIMEOUT_MS,
  );
  if (listResult.code !== 0) {
    throw new Error(
      `skills list failed: ${describeSubprocessFailure(listResult, "skills list")}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listResult.stdout || "[]");
  } catch {
    const stdoutPreview = printable(listResult.stdout.trim().slice(0, 200));
    const detail = listResult.stderr.trim()
      ? describeSubprocessFailure(listResult, "skills list")
      : stdoutPreview || "no command output";
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
  const declinedGroupIds = declinedSkillGroupIds(ctx);
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

function latestConfirmedSkillRecord(
  ctx: Context,
  skillName: string,
): LedgerEntry | undefined {
  return skillsLedgerEntries(ctx)
    .filter(
      (action) =>
        action.target === skillName &&
        (action.type === ACTION_TYPE_INSTALLED_SKILL ||
          action.type === ACTION_TYPE_PREEXISTING_SKILL) &&
        ctx.manifest.isConfirmed(action),
    )
    .at(-1);
}

function isUpdatableBundledSkill(
  ctx: Context,
  group: SkillGroup,
  entry: SkillBundleEntry,
): boolean {
  return (
    !group.definedByRepository &&
    hasManagedInstallRecord(ctx, entry.skillName) &&
    latestConfirmedSkillRecord(ctx, entry.skillName)?.type !==
      ACTION_TYPE_PREEXISTING_SKILL
  );
}

interface KeptSkill {
  name: string;
  reason: string;
}

interface GroupRevisionReport {
  outdatedNames: string[];
  kept: KeptSkill[];
}

async function reportGroupRevisions(
  ctx: Context,
  group: SkillGroup,
): Promise<GroupRevisionReport> {
  const report: GroupRevisionReport = { outdatedNames: [], kept: [] };
  for (const entry of group.skills) {
    if (!isUpdatableBundledSkill(ctx, group, entry)) {
      continue;
    }
    const classification = await classifyInstalledSkillForReport(ctx, entry);
    if (classification.kind === "outdated") {
      report.outdatedNames.push(entry.skillName);
    } else if (classification.kind === "kept") {
      report.kept.push({
        name: entry.skillName,
        reason: classification.reason,
      });
    }
  }
  return report;
}

function describeGroupRevisions(report: GroupRevisionReport): string[] {
  const fragments: string[] = [];
  if (report.outdatedNames.length > 0) {
    fragments.push(
      `update available for ${report.outdatedNames.length} skill(s)`,
    );
  }
  if (report.kept.length > 0) {
    fragments.push(
      `agemon keeps ${report.kept.map(({ name }) => name).join(", ")}`,
    );
  }
  return fragments;
}

function describeKeptSkill({ name, reason }: KeptSkill): string {
  return `skills: agemon keeps ${name} (${reason}); to get agemon's version, delete ${CLAUDE_SKILLS_DIRECTORY}/${name} and run agemon`;
}

function presentGroupState(
  ctx: Context,
  group: SkillGroup,
  revisions: GroupRevisionReport,
): CapabilityState {
  if (revisions.kept.length > 0) {
    return "present-modified";
  }
  const allManaged = group.skills.every((skill) =>
    hasManagedInstallRecord(ctx, skill.skillName),
  );
  return allManaged ? "present-managed" : "present-adopted";
}

function orphanedSkillEntries(ctx: Context): LedgerEntry[] {
  const groupSkillNames = new Set(
    flattenSkills(getAvailableGroups(ctx)).map((entry) => entry.skillName),
  );
  return skillsLedgerEntries(ctx).filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.preExisting === false &&
      isPlainSkillName(action.target) &&
      !groupSkillNames.has(action.target),
  );
}

function describeOrphanedSkills(ctx: Context): CapabilityStateRow[] {
  const orphanedEntries = orphanedSkillEntries(ctx);
  const names = [...new Set(orphanedEntries.map((entry) => entry.target))];
  if (names.length === 0) {
    return [];
  }
  const confirmedNames = new Set(
    orphanedEntries
      .filter((entry) => ctx.manifest.isConfirmed(entry))
      .map((entry) => entry.target),
  );
  const unconfirmedCount = names.filter(
    (name) => !confirmedNames.has(name),
  ).length;
  const claimNote =
    unconfirmedCount === 0
      ? ""
      : ` (${unconfirmedCount} not recorded on this machine; nuke keeps those)`;
  return [
    {
      capabilityId: PLUGIN_ID,
      resourceId: ORPHANED_SKILLS_RESOURCE_ID,
      label: "skills of removed groups",
      state: unconfirmedCount === 0 ? "present-managed" : "present-adopted",
      detail: `${names.join(", ")}: their skill group is no longer defined; 'agemon nuke --only skills' removes them${claimNote}`,
    },
  ];
}

async function describeSkillsState(
  ctx: Context,
): Promise<CapabilityStateRow[]> {
  const reportableGroups = getReportableGroups(ctx);
  const orphanedRows = describeOrphanedSkills(ctx);
  if (reportableGroups.length === 0) {
    return orphanedRows.length > 0
      ? orphanedRows
      : [
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

  const declinedGroupIds = declinedSkillGroupIds(ctx);

  const groupRows: CapabilityStateRow[] = [];
  for (const group of reportableGroups) {
    const resourceId = groupResourceId(group);
    const installedCount = group.skills.filter((skill) =>
      installedSkillNames.has(skill.skillName),
    ).length;

    if (installedCount < group.skills.length) {
      groupRows.push({
        capabilityId: PLUGIN_ID,
        resourceId,
        label: group.label,
        state:
          installedCount === 0 && declinedGroupIds.has(group.id)
            ? "declined"
            : "absent",
        detail: `${installedCount}/${group.skills.length} skills installed`,
      });
      continue;
    }

    const revisions = await reportGroupRevisions(ctx, group);
    groupRows.push({
      capabilityId: PLUGIN_ID,
      resourceId,
      label: group.label,
      state: presentGroupState(ctx, group, revisions),
      detail: [
        `${group.skills.length} skill(s)`,
        ...describeGroupRevisions(revisions),
      ].join("; "),
    });
  }
  return [...groupRows, ...orphanedRows];
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

function skillUpdatesFingerprint(updates: SkillUpdate[]): string {
  return fingerprintJson(
    updates.map((update) => [
      update.name,
      update.installedFingerprint,
      update.currentFingerprint,
    ]),
  );
}

async function findSkillUpdates(
  ctx: Context,
  group: SkillGroup,
  classify: typeof classifyInstalledSkill,
): Promise<SkillUpdate[]> {
  const updates: SkillUpdate[] = [];
  for (const entry of group.skills) {
    if (!isUpdatableBundledSkill(ctx, group, entry)) {
      continue;
    }
    const classification = await classify(ctx, entry);
    if (classification.kind === "outdated") {
      updates.push({
        name: entry.skillName,
        installedFingerprint: classification.installedFingerprint,
        currentFingerprint: classification.currentFingerprint,
      });
    }
  }
  return updates;
}

async function describeGroupInstall(
  ctx: Context,
  group: SkillGroup,
  updates: SkillUpdate[],
): Promise<ProposedOperation> {
  const localFingerprints = await fingerprintLocalSkills(ctx, group);
  const updatedNames = new Set(updates.map((update) => update.name));
  const skillLines = group.skills.map((entry) => {
    const localFingerprint = localFingerprints.get(entry.skillName);
    const contentNote =
      localFingerprint === undefined
        ? ""
        : ` in this repository, content sha256 ${localFingerprint.slice(0, 16)}`;
    const updateNote = updatedNames.has(entry.skillName)
      ? UPDATE_PREVIEW_NOTE
      : "";
    return `${entry.skillName} — ${describeSkillSource(entry)}${contentNote}${updateNote}`;
  });
  return describeOperation({
    capabilityId: PLUGIN_ID,
    resourceId: groupResourceId(group),
    targetPath: "",
    action: "install-package",
    riskClass: "executes",
    requiresConsent: true,
    expectedFingerprint:
      updates.length > 0
        ? skillUpdatesFingerprint(updates)
        : combineLocalFingerprints(localFingerprints),
    preview: {
      kind: "note",
      text: [`${group.label}:`, ...skillLines].join("\n"),
    },
    ...(updates.length > 0 ? { updates } : {}),
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
  const updatesByGroupId = new Map<string, SkillUpdate[]>();
  for (const group of recordedGroups) {
    const updates = await findSkillUpdates(
      ctx,
      group,
      classifyInstalledSkillForReport,
    );
    if (updates.length > 0) {
      updatesByGroupId.set(group.id, updates);
    }
  }
  const groupIdsToInstall = new Set([
    ...[
      ...(await findGroupsMissingSkills(ctx, recordedGroups)),
      ...selection.chosen,
    ].map((group) => group.id),
    ...updatesByGroupId.keys(),
  ]);
  const availableGroups = getAvailableGroups(ctx);
  const groupsToInstall = availableGroups.filter((group) =>
    groupIdsToInstall.has(group.id),
  );
  const declinedGroups = selection.offered.filter(
    (group) => !groupIdsToInstall.has(group.id),
  );

  const operations: ProposedOperation[] = [];
  for (const group of groupsToInstall) {
    operations.push(
      await describeGroupInstall(
        ctx,
        group,
        updatesByGroupId.get(group.id) ?? [],
      ),
    );
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
    group.definedByRepository &&
    combineLocalFingerprints(fingerprints) !== operation.expectedFingerprint
  ) {
    throw new Error(
      `The custom skill group '${group.id}' changed since it was planned. Re-run 'agemon plan' and review it again.`,
    );
  }
  return stagedPaths;
}

interface PlannedSkillUpdate {
  group: SkillGroup;
  entry: SkillBundleEntry;
  update: SkillUpdate;
}

function changedSincePlanned(group: SkillGroup): Error {
  return new Error(
    `The skill group '${group.id}' changed since it was planned. Re-run 'agemon plan' and review it again.`,
  );
}

async function confirmPlannedUpdates({
  ctx,
  group,
  operation,
}: GroupInstall & { ctx: Context }): Promise<PlannedSkillUpdate[]> {
  if ((operation.updates ?? []).length === 0) {
    return [];
  }
  const updates = await findSkillUpdates(ctx, group, classifyInstalledSkill);
  if (skillUpdatesFingerprint(updates) !== operation.expectedFingerprint) {
    throw changedSincePlanned(group);
  }
  return updates.flatMap((update) => {
    const entry = group.skills.find(
      (candidate) => candidate.skillName === update.name,
    );
    return entry === undefined ? [] : [{ group, entry, update }];
  });
}

async function assertStillOutdatedAsPlanned(
  ctx: Context,
  { group, entry, update }: PlannedSkillUpdate,
): Promise<void> {
  const classification = await classifyInstalledSkill(ctx, entry);
  if (
    classification.kind !== "outdated" ||
    classification.installedFingerprint !== update.installedFingerprint
  ) {
    throw changedSincePlanned(group);
  }
}

async function discardHalfWrittenCopy(
  ctx: Context,
  { update }: PlannedSkillUpdate,
): Promise<string> {
  const installed = await installedSkillFingerprint(ctx, update.name);
  if (installed === update.installedFingerprint) {
    return `${CLAUDE_SKILLS_DIRECTORY}/${update.name} is unchanged`;
  }
  await removeInstalledSkillCopy(ctx.cwd, update.name);
  return `agemon removed ${CLAUDE_SKILLS_DIRECTORY}/${update.name} so the next run reinstalls it`;
}

async function updateSkills(
  ctx: Context,
  plannedUpdates: PlannedSkillUpdate[],
): Promise<void> {
  if (plannedUpdates.length === 0) {
    return;
  }
  const entriesToUpdate = plannedUpdates.map(({ entry }) => entry);
  await fetchPinnedSources(ctx, entriesToUpdate);
  await assertSkillsCliTargetsStayInRepo(
    ctx.cwd,
    entriesToUpdate.map((entry) => entry.skillName),
    { create: true },
  );
  for (const plannedUpdate of plannedUpdates) {
    const { entry } = plannedUpdate;
    await assertStillOutdatedAsPlanned(ctx, plannedUpdate);
    const addResult = await runSkillsCli(
      ctx,
      [
        "add",
        entry.source,
        "--skill",
        entry.skillName,
        "--agent",
        entry.agent,
        "--yes",
      ],
      SKILLS_ADD_TIMEOUT_MS,
    );
    if (addResult.code !== 0) {
      const outcome = await discardHalfWrittenCopy(ctx, plannedUpdate);
      throw new Error(
        `skills add failed for ${printable(entry.skillName)}: ${describeSubprocessFailure(addResult, "skills add")}. ${outcome}.`,
      );
    }
    const installed = await installedSkillFingerprint(ctx, entry.skillName);
    if (installed !== (await currentSkillFingerprint(entry))) {
      await removeInstalledSkillCopy(ctx.cwd, entry.skillName);
      throw new Error(
        `The skills CLI installed ${entry.skillName} with different content than agemon bundles; agemon removed ${CLAUDE_SKILLS_DIRECTORY}/${entry.skillName} so the next run reinstalls it.`,
      );
    }
    ctx.ui.info(
      `Updated skill ${entry.skillName} to the version bundled with this agemon`,
    );
  }
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
        `skills add failed for ${printable(entry.skillName)}: ${describeSubprocessFailure(addResult, "skills add")}`,
      );
    }

    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: ACTION_TYPE_INSTALLED_SKILL,
      target: entry.skillName,
      preExisting: false,
      fingerprintAfter: customSkillNames(ctx).has(entry.skillName)
        ? await verifiedCustomInstallFingerprint(
            ctx,
            entry,
            stagedPaths.get(entry.skillName),
          )
        : null,
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

  const plannedUpdates: PlannedSkillUpdate[] = [];
  for (const groupInstall of groupInstalls) {
    plannedUpdates.push(
      ...(await confirmPlannedUpdates({ ...groupInstall, ctx })),
    );
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

  try {
    await withAgemonStateLock(
      "skills-src.lock",
      async () => {
        await addSkills(ctx, entriesToAdd, stagedPaths);
        await updateSkills(ctx, plannedUpdates);
      },
      SKILLS_SOURCE_LOCK_WAIT_MS,
    );
  } finally {
    forgetSkillClassifications(ctx);
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
): Promise<undefined> {
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

  const outdatedNames: string[] = [];
  for (const group of recordedGroups) {
    const revisions = await reportGroupRevisions(ctx, group);
    outdatedNames.push(...revisions.outdatedNames);
    for (const keptSkill of revisions.kept) {
      ctx.ui.info(printable(describeKeptSkill(keptSkill)));
    }
  }
  return {
    ok: true,
    detail: `${recordedGroups.length} skill group(s), ${recordedEntries.length} skill(s) present`,
    ...(outdatedNames.length > 0
      ? {
          attention: `a newer bundled version of ${outdatedNames.join(", ")} is available; run agemon`,
        }
      : {}),
  };
}

function reportUnconfirmedSkills(
  ctx: Context,
  installEntries: LedgerEntry[],
  confirmedEntries: LedgerEntry[],
): void {
  const confirmedNames = new Set(confirmedEntries.map((entry) => entry.target));
  const presentSkillDirectories = (name: string) =>
    [CLAUDE_SKILLS_DIRECTORY, CANONICAL_SKILLS_DIRECTORY]
      .map((directory) => `${directory}/${name}`)
      .filter((directory) => existsSync(join(ctx.cwd, directory)));
  const keptNames = [
    ...new Set(
      installEntries
        .map((entry) => entry.target)
        .filter(
          (name) =>
            !confirmedNames.has(name) &&
            isPlainSkillName(name) &&
            presentSkillDirectories(name).length > 0,
        ),
    ),
  ];
  if (keptNames.length === 0) {
    return;
  }
  const directories = keptNames.flatMap(presentSkillDirectories);
  ctx.ui.info(
    `${ctx.dryRun ? "Would keep" : "Keeping"} skills that agemon has no record of installing in this repository on this machine: ${keptNames.join(", ")}. If you don't need them, delete ${directories.join(", ")}.`,
  );
}

function recordedInstallFingerprints(
  confirmedInstallEntries: LedgerEntry[],
  skillName: string,
): string[] {
  return confirmedInstallEntries
    .filter((action) => action.target === skillName)
    .map((action) => action.fingerprintAfter)
    .filter((fingerprint) => fingerprint !== null);
}

async function revertSkills(
  ctx: Context,
  entries: LedgerEntry[],
): Promise<void> {
  const installEntries = entries.filter(
    (action) =>
      action.type === ACTION_TYPE_INSTALLED_SKILL &&
      action.preExisting === false,
  );
  const managedActions = installEntries.filter((action) =>
    ctx.manifest.isConfirmed(action),
  );
  const lockEntries = entries.filter(isManagedSkillsLockEntry);
  const shouldRemoveManagedSkillsLock = lockEntries.some((action) =>
    ctx.manifest.isConfirmed(action),
  );
  reportUnconfirmedSkills(ctx, installEntries, managedActions);
  if (lockEntries.length > 0 && !shouldRemoveManagedSkillsLock) {
    ctx.ui.info(
      `${ctx.dryRun ? "Would keep" : "Keeping"} ${SKILLS_LOCK_FILE}: agemon has no record on this machine that it created it.`,
    );
  }

  const managedSkillNames = new Set(
    managedActions.map((action) => action.target),
  );
  const forgedName = [...managedSkillNames].find(
    (skillName) => !isPlainSkillName(skillName),
  );
  if (forgedName !== undefined) {
    throw new RefusedPathError(
      `Refusing to remove the skill '${printable(forgedName)}': it is not a plain skill name. The ledger in .agemon/state.json may have been edited; check it before running agemon again.`,
    );
  }

  const removedNames: string[] = [];
  const failures: string[] = [];
  for (const skillName of managedSkillNames) {
    const entry = flattenSkills(getAvailableGroups(ctx)).find(
      (candidate) => candidate.skillName === skillName,
    );
    const agemonFingerprints = await fingerprintsAgemonInstalled(
      skillName,
      entry,
      recordedInstallFingerprints(managedActions, skillName),
    );
    const removal = await removeAgemonSkillCopy(ctx, skillName, (fingerprint) =>
      agemonFingerprints.has(fingerprint),
    );
    if (removal.kind === "failed") {
      failures.push(removal.detail);
      continue;
    }
    if (removal.kind === "removed" || removal.kind === "gone") {
      removedNames.push(skillName);
      const shipped = new Set(shippedFingerprints(skillName));
      await reportLeftCanonicalCopy(ctx, skillName, (fingerprint) =>
        shipped.has(fingerprint),
      );
    }
  }
  await removeSkillsFromLock(ctx, removedNames, shouldRemoveManagedSkillsLock);
  if (failures.length > 0) {
    throw new Error(
      `Could not remove skill copies — ${failures.join("; ")}. Fix the cause and run 'agemon nuke' again.`,
    );
  }
}

async function uninstallSkills(ctx: Context): Promise<void> {
  await revertSkills(ctx, skillsLedgerEntries(ctx));
}

async function describeKeptUpdates(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const update of operations.flatMap(
    (operation) => operation.updates ?? [],
  )) {
    const installed = await installedSkillFingerprint(ctx, update.name);
    if (
      installed === update.currentFingerprint &&
      installed !== update.installedFingerprint
    ) {
      lines.push(`updated skill ${update.name} (agemon's newer version)`);
    }
  }
  return lines;
}

export const skillsPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  riskClass: "executes",
  detect: detectSkills,
  describeState: describeSkillsState,
  plan: planSkills,
  apply: applySkills,
  verify: verifySkills,
  revert: revertSkills,
  describeKeptAfterRollback: describeKeptUpdates,
  uninstall: uninstallSkills,
};
