import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import {
  fakePinnedSkillFingerprint,
  fakeSubprocessesActive,
} from "../../core/fake-pinned-skills.js";
import { RefusedFileError } from "../../core/files.js";
import { resolveRepoDirectory } from "../../core/repo-paths.js";
import { ESSENTIALS_SKILLS_COMMIT } from "../pins.js";
import { BUNDLE_FINGERPRINTS } from "./bundle-fingerprints.js";
import type { SkillBundleEntry } from "./catalog.js";
import {
  isPristinePinnedCheckout,
  resolvePinnedSkillPath,
} from "./pinned-source.js";
import {
  fingerprintInstalledSkill,
  fingerprintSkillSource,
  SkillTreeRefusal,
} from "./skill-tree.js";
import {
  CANONICAL_SKILLS_DIRECTORY,
  CLAUDE_SKILLS_DIRECTORY,
} from "./skills-cli-targets.js";

export type SkillClassification =
  | { kind: "current" }
  | {
      kind: "outdated";
      installedFingerprint: string;
      currentFingerprint: string;
    }
  | { kind: "kept"; reason: string };

const DIFFERS_FROM_EVERY_VERSION = "differs from every version agemon shipped";

const vendoredFingerprintsBySource = new Map<string, Promise<string | null>>();
const reportClassifications = new WeakMap<
  Context,
  Map<string, Promise<SkillClassification>>
>();

function kept(reason: string): SkillClassification {
  return { kind: "kept", reason };
}

function vendoredSourceFingerprint(source: string): Promise<string | null> {
  let pending = vendoredFingerprintsBySource.get(source);
  if (pending === undefined) {
    pending = fingerprintSkillSource(source).catch(() => null);
    vendoredFingerprintsBySource.set(source, pending);
  }
  return pending;
}

export async function currentSkillFingerprint(
  entry: SkillBundleEntry,
): Promise<string | null> {
  if (entry.localSourcePath !== undefined) {
    return null;
  }
  if (entry.pinnedRepository !== undefined) {
    const isEssentialsPin =
      entry.pinnedRepository.commit === ESSENTIALS_SKILLS_COMMIT;
    if (isEssentialsPin && fakeSubprocessesActive()) {
      return fakePinnedSkillFingerprint(entry.skillName);
    }
    const pinnedCommit = ownValue(
      BUNDLE_FINGERPRINTS.pinned,
      entry.pinnedRepository.commit,
    );
    return pinnedCommit === undefined
      ? null
      : (ownValue(pinnedCommit, entry.skillName) ?? null);
  }
  let source: string;
  try {
    source = entry.source;
  } catch {
    return null;
  }
  return vendoredSourceFingerprint(source);
}

function ownValue<Value>(
  record: Record<string, Value>,
  key: string,
): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function shippedFingerprints(skillName: string): readonly string[] {
  return ownValue(BUNDLE_FINGERPRINTS.history, skillName) ?? [];
}

export async function fingerprintsAgemonInstalled(
  skillName: string,
  entry: SkillBundleEntry | undefined,
  recordedInstallFingerprints: string[],
): Promise<Set<string>> {
  const fingerprints = new Set([
    ...shippedFingerprints(skillName),
    ...recordedInstallFingerprints,
  ]);
  const current =
    entry === undefined ? null : await currentSkillFingerprint(entry);
  if (current !== null) {
    fingerprints.add(current);
  }
  return fingerprints;
}

async function pristineCheckoutSkillPath(
  ctx: Context,
  entry: SkillBundleEntry,
): Promise<string | null> {
  const repository = entry.pinnedRepository;
  return repository !== undefined &&
    (await isPristinePinnedCheckout(ctx, repository))
    ? resolvePinnedSkillPath(repository, entry.skillName)
    : null;
}

export async function verifiedCustomInstallFingerprint(
  ctx: Context,
  entry: SkillBundleEntry,
  stagedSourcePath: string | undefined,
): Promise<string | null> {
  const sourcePath =
    stagedSourcePath ?? (await pristineCheckoutSkillPath(ctx, entry));
  if (sourcePath === null) {
    return null;
  }
  const sourceFingerprint = await fingerprintSkillSource(sourcePath).catch(
    () => null,
  );
  const installed = await installedSkillFingerprint(ctx, entry.skillName);
  return sourceFingerprint !== null && sourceFingerprint === installed
    ? installed
    : null;
}

function describeReadFailure(error: unknown): string {
  if (error instanceof SkillTreeRefusal) {
    return error.message;
  }
  if (error instanceof RefusedFileError) {
    return "it is a symlink or sits under a symlinked directory";
  }
  const code = (error as NodeJS.ErrnoException).code;
  return `agemon could not read it (${code ?? "unknown error"})`;
}

async function linkedCanonicalFingerprint(
  ctx: Context,
  skillName: string,
  copyPath: string,
): Promise<string | SkillClassification> {
  const canonicalDirectory = await resolveRepoDirectory(
    ctx.cwd,
    `${CANONICAL_SKILLS_DIRECTORY}/${skillName}`,
  );
  const expectedTarget = join(
    await realpath(ctx.cwd),
    CANONICAL_SKILLS_DIRECTORY,
    skillName,
  );
  if (
    canonicalDirectory === null ||
    (await realpath(copyPath)) !== expectedTarget
  ) {
    return kept(
      `it is a symlink that does not point to ${CANONICAL_SKILLS_DIRECTORY}/${skillName}`,
    );
  }
  const fingerprint = await fingerprintInstalledSkill(canonicalDirectory);
  return shippedFingerprints(skillName).includes(fingerprint)
    ? fingerprint
    : kept(`it is a symlink to a copy that ${DIFFERS_FROM_EVERY_VERSION}`);
}

async function installedFingerprint(
  ctx: Context,
  skillName: string,
): Promise<string | SkillClassification> {
  const notThere = kept(`not at ${CLAUDE_SKILLS_DIRECTORY}/${skillName}`);
  const skillsDirectory = await resolveRepoDirectory(
    ctx.cwd,
    CLAUDE_SKILLS_DIRECTORY,
  );
  if (skillsDirectory === null) {
    return notThere;
  }
  const copyPath = join(skillsDirectory, skillName);
  const stats = await lstat(copyPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (stats === null) {
    return notThere;
  }
  if (stats.isSymbolicLink()) {
    return linkedCanonicalFingerprint(ctx, skillName, copyPath);
  }
  if (!stats.isDirectory()) {
    return kept("it is not a directory");
  }
  return fingerprintInstalledSkill(copyPath);
}

export async function classifyInstalledSkill(
  ctx: Context,
  entry: SkillBundleEntry,
): Promise<SkillClassification> {
  const current = await currentSkillFingerprint(entry);
  if (current === null) {
    return kept("agemon can't tell which version it ships");
  }
  let installed: string | SkillClassification;
  try {
    installed = await installedFingerprint(ctx, entry.skillName);
  } catch (error) {
    return kept(describeReadFailure(error));
  }
  if (typeof installed !== "string") {
    return installed;
  }
  if (installed === current) {
    return { kind: "current" };
  }
  return shippedFingerprints(entry.skillName).includes(installed)
    ? {
        kind: "outdated",
        installedFingerprint: installed,
        currentFingerprint: current,
      }
    : kept(DIFFERS_FROM_EVERY_VERSION);
}

export async function installedSkillFingerprint(
  ctx: Context,
  skillName: string,
): Promise<string | null> {
  try {
    const installed = await installedFingerprint(ctx, skillName);
    return typeof installed === "string" ? installed : null;
  } catch {
    return null;
  }
}

export function classifyInstalledSkillForReport(
  ctx: Context,
  entry: SkillBundleEntry,
): Promise<SkillClassification> {
  let classifications = reportClassifications.get(ctx);
  if (classifications === undefined) {
    classifications = new Map();
    reportClassifications.set(ctx, classifications);
  }
  let pending = classifications.get(entry.skillName);
  if (pending === undefined) {
    pending = classifyInstalledSkill(ctx, entry);
    classifications.set(entry.skillName, pending);
  }
  return pending;
}

export function forgetSkillClassifications(ctx: Context): void {
  reportClassifications.delete(ctx);
}
