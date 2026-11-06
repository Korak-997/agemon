import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import { RefusedFileError } from "../../core/files.js";
import {
  ensureRepoDirectory,
  resolveRepoDirectory,
} from "../../core/repo-paths.js";
import type { LedgerEntry } from "../../core/state-manifest.js";
import { printable } from "../../core/untrusted-text.js";
import { recordCreatedDirectories } from "../../core/workspace-footprint.js";
import {
  ACTION_TYPE_AGENTS_SKILL_COPY,
  SKILLS_PLUGIN_ID,
  skillsLedgerEntries,
} from "./ledger-view.js";
import {
  invokedOnlyByName,
  portableSkillManifest,
} from "./portable-manifest.js";
import {
  AGENTS_COPY_LOCATION,
  removeAgemonSkillCopy,
} from "./skill-removal.js";
import {
  fingerprintInstalledSkill,
  fingerprintSkillTree,
  readInstalledSkill,
  type SkillTreeEntry,
} from "./skill-tree.js";
import { CANONICAL_SKILLS_DIRECTORY } from "./skills-cli-targets.js";

const SKILL_MANIFEST_PATH = "SKILL.md";
const STAGE_PREFIX = ".agemon-writing-";
const STAGE_SUFFIX_BYTES = 8;

const NOT_COPIED_INVOKED_BY_NAME =
  "not copied: it must run only when named, and not every agent reading .agents/skills honours that";
const NOT_COPIED_UNPORTABLE =
  "not copied: agemon could not read it or make its frontmatter portable";
const KEPT_NOT_WRITTEN_BY_AGEMON = "already there and agemon did not write it";
const KEPT_CHANGED = "changed since agemon wrote it";

interface AgentNeedingAgentsDirectory {
  name: string;
  executables: readonly string[];
  repositoryMarker?: string;
}

const AGENTS_NEEDING_AGENTS_DIRECTORY: readonly AgentNeedingAgentsDirectory[] =
  [
    { name: "Codex", executables: ["codex"], repositoryMarker: ".codex" },
    {
      name: "Gemini CLI",
      executables: ["gemini"],
      repositoryMarker: ".gemini",
    },
    { name: "Antigravity", executables: ["antigravity", "agy"] },
    { name: "Devin", executables: ["devin"], repositoryMarker: ".devin" },
  ];

export interface CopyCandidate {
  skillName: string;
  sourceDirectory: string | null;
}

export interface CopyReview {
  toAdd: string[];
  toUpdate: string[];
  notCopied: { skillName: string; reason: string }[];
  kept: { skillName: string; reason: string }[];
}

type CopyState =
  | "missing"
  | "current"
  | "outdated"
  | "not-written-by-agemon"
  | "changed";

interface DesiredCopy {
  fingerprint: string;
  entries: SkillTreeEntry[];
}

export async function detectAgentsNeedingCopies(
  ctx: Context,
): Promise<string[]> {
  const detected: string[] = [];
  for (const agent of AGENTS_NEEDING_AGENTS_DIRECTORY) {
    const inRepository =
      agent.repositoryMarker !== undefined &&
      existsSync(join(ctx.cwd, agent.repositoryMarker));
    let onPath = false;
    if (!inRepository && ctx.isExecutableOnPath !== undefined) {
      for (const executable of agent.executables) {
        onPath ||= await ctx.isExecutableOnPath(executable);
      }
    }
    if (inRepository || onPath) {
      detected.push(agent.name);
    }
  }
  return detected;
}

function copyRecords(ctx: Context): LedgerEntry[] {
  return skillsLedgerEntries(ctx).filter(
    (action) => action.type === ACTION_TYPE_AGENTS_SKILL_COPY,
  );
}

export function confirmedCopyRecords(ctx: Context): LedgerEntry[] {
  return copyRecords(ctx).filter((action) => ctx.manifest.isConfirmed(action));
}

function confirmedCopyRecord(
  ctx: Context,
  skillName: string,
): LedgerEntry | undefined {
  return confirmedCopyRecords(ctx).find(
    (action) => action.target === skillName,
  );
}

async function readDesiredCopy(
  sourceDirectory: string,
): Promise<DesiredCopy | "invoked-by-name" | "unportable"> {
  const entries = await readInstalledSkill(sourceDirectory).catch(() => null);
  const manifestBytes = entries?.find(
    (entry) => entry.relativePath === SKILL_MANIFEST_PATH,
  )?.contents;
  if (entries === null || !manifestBytes) {
    return "unportable";
  }
  const source = manifestBytes.toString("utf8");
  if (invokedOnlyByName(source)) {
    return "invoked-by-name";
  }
  const manifest = portableSkillManifest(source);
  if (manifest === null) {
    return "unportable";
  }
  const portableEntries = entries.map((entry) =>
    entry.relativePath === SKILL_MANIFEST_PATH
      ? { ...entry, contents: Buffer.from(manifest) }
      : entry,
  );
  return {
    entries: portableEntries,
    fingerprint: fingerprintSkillTree(portableEntries),
  };
}

async function classifyCopy(
  ctx: Context,
  skillName: string,
  desiredFingerprint: string | null,
): Promise<CopyState> {
  const copyPath = join(ctx.cwd, CANONICAL_SKILLS_DIRECTORY, skillName);
  const stats = await lstat(copyPath).catch(() => null);
  if (stats === null) {
    return "missing";
  }
  if (!stats.isDirectory()) {
    return "not-written-by-agemon";
  }
  const record = confirmedCopyRecord(ctx, skillName);
  if (record === undefined) {
    return "not-written-by-agemon";
  }
  const fingerprint = await fingerprintInstalledSkill(copyPath).catch(
    () => null,
  );
  if (fingerprint === null || fingerprint !== record.fingerprintAfter) {
    return "changed";
  }
  return desiredFingerprint === null || fingerprint === desiredFingerprint
    ? "current"
    : "outdated";
}

async function agentsDirectoryIsWritable(ctx: Context): Promise<boolean> {
  try {
    await resolveRepoDirectory(ctx.cwd, CANONICAL_SKILLS_DIRECTORY);
    return true;
  } catch (error) {
    if (error instanceof RefusedFileError) {
      return false;
    }
    throw error;
  }
}

export async function reviewCopies(
  ctx: Context,
  candidates: CopyCandidate[],
): Promise<CopyReview> {
  const review: CopyReview = {
    toAdd: [],
    toUpdate: [],
    notCopied: [],
    kept: [],
  };
  const writable = await agentsDirectoryIsWritable(ctx);
  for (const { skillName, sourceDirectory } of candidates) {
    const desired =
      sourceDirectory === null ? null : await readDesiredCopy(sourceDirectory);
    if (desired === "invoked-by-name") {
      review.notCopied.push({ skillName, reason: NOT_COPIED_INVOKED_BY_NAME });
      continue;
    }
    if (desired === "unportable") {
      review.notCopied.push({ skillName, reason: NOT_COPIED_UNPORTABLE });
      continue;
    }
    const state = writable
      ? await classifyCopy(ctx, skillName, desired?.fingerprint ?? null)
      : "not-written-by-agemon";
    if (state === "missing") {
      review.toAdd.push(skillName);
    } else if (state === "outdated") {
      review.toUpdate.push(skillName);
    } else if (state === "not-written-by-agemon") {
      review.kept.push({ skillName, reason: KEPT_NOT_WRITTEN_BY_AGEMON });
    } else if (state === "changed") {
      review.kept.push({ skillName, reason: KEPT_CHANGED });
    }
  }
  return review;
}

export function describeCopyPlan(agents: string[], review: CopyReview): string {
  return [
    agents.length > 0
      ? `${CANONICAL_SKILLS_DIRECTORY}, for ${agents.join(", ")}:`
      : `${CANONICAL_SKILLS_DIRECTORY}:`,
    ...review.toAdd,
    ...review.toUpdate.map((name) => `${name} — update`),
    ...review.notCopied.map(
      ({ skillName, reason }) => `${skillName} — ${reason}`,
    ),
    ...review.kept.map(
      ({ skillName, reason }) => `${skillName} — kept: ${reason}`,
    ),
  ].join("\n");
}

function isLostPublishRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
}

async function writeStage(
  stagePath: string,
  entries: SkillTreeEntry[],
): Promise<void> {
  await mkdir(stagePath);
  for (const { relativePath, contents, mode } of entries) {
    const path = join(stagePath, relativePath);
    if (contents === null) {
      await mkdir(path);
    } else {
      await writeFile(path, contents, { flag: "wx", mode });
    }
  }
}

async function publishCopy(
  skillsDirectory: string,
  skillName: string,
  desired: DesiredCopy,
): Promise<boolean> {
  const stagePath = join(
    skillsDirectory,
    `${STAGE_PREFIX}${skillName}-${randomBytes(STAGE_SUFFIX_BYTES).toString("hex")}`,
  );
  try {
    // Written from the entries already read, so a source swapped for a symlink cannot redirect a write.
    await writeStage(stagePath, desired.entries);
    await rename(stagePath, join(skillsDirectory, skillName));
    return true;
  } catch (error) {
    if (isLostPublishRace(error)) {
      return false;
    }
    throw error;
  } finally {
    await rm(stagePath, { recursive: true, force: true });
  }
}

async function recordCopy(
  ctx: Context,
  skillName: string,
  fingerprint: string,
): Promise<void> {
  await ctx.manifest.removeActionIds(
    copyRecords(ctx)
      .filter((action) => action.target === skillName)
      .map((action) => action.id),
  );
  await ctx.manifest.recordAction({
    plugin: SKILLS_PLUGIN_ID,
    type: ACTION_TYPE_AGENTS_SKILL_COPY,
    target: skillName,
    preExisting: false,
    fingerprintAfter: fingerprint,
  });
}

function reportKept(ctx: Context, skillName: string, reason: string): void {
  ctx.ui.info(
    `Keeping ${CANONICAL_SKILLS_DIRECTORY}/${printable(skillName)}: ${reason}.`,
  );
}

export async function writeCopies(
  ctx: Context,
  candidates: CopyCandidate[],
): Promise<void> {
  const review = await reviewCopies(ctx, candidates);
  for (const { skillName, reason } of review.kept) {
    reportKept(ctx, skillName, reason);
  }
  const toWrite = [...review.toAdd, ...review.toUpdate];
  if (toWrite.length === 0) {
    return;
  }
  await recordCreatedDirectories(
    ctx,
    await ensureRepoDirectory(ctx.cwd, CANONICAL_SKILLS_DIRECTORY),
  );
  const skillsDirectory = join(ctx.cwd, CANONICAL_SKILLS_DIRECTORY);
  for (const { skillName, sourceDirectory } of candidates) {
    if (sourceDirectory === null || !toWrite.includes(skillName)) {
      continue;
    }
    const desired = await readDesiredCopy(sourceDirectory);
    if (typeof desired === "string") {
      continue;
    }
    if (
      review.toUpdate.includes(skillName) &&
      (await removeRecordedCopy(ctx, skillName)) === "kept"
    ) {
      continue;
    }
    if (await publishCopy(skillsDirectory, skillName, desired)) {
      await recordCopy(ctx, skillName, desired.fingerprint);
    } else {
      reportKept(ctx, skillName, KEPT_NOT_WRITTEN_BY_AGEMON);
    }
  }
}

export async function removeRecordedCopy(
  ctx: Context,
  skillName: string,
): Promise<"removed" | "kept"> {
  const record = confirmedCopyRecord(ctx, skillName);
  if (record === undefined) {
    return "kept";
  }
  const removal = await removeAgemonSkillCopy(
    ctx,
    skillName,
    (fingerprint) => fingerprint === record.fingerprintAfter,
    AGENTS_COPY_LOCATION,
  );
  if (removal.kind === "failed") {
    throw new Error(`Could not remove a skill copy — ${removal.detail}`);
  }
  return removal.kind === "kept" ? "kept" : "removed";
}
