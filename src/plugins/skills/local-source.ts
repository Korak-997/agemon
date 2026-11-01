import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveInsideRepo,
  resolveRepoDirectory,
} from "../../core/repo-paths.js";
import { preparePrivateStateDirectory } from "../../core/state-root.js";
import { printable } from "../../core/untrusted-text.js";
import { assertSkillManifestName } from "./skill-manifest.js";
import {
  fingerprintSkillTree,
  readSkillTree,
  type SkillTreeEntry,
  SkillTreeRefusal,
} from "./skill-tree.js";

const SKILL_MANIFEST_FILE = "SKILL.md";
const STAGE_DIRECTORY_NAME = "skills-stage";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface LocalSkill {
  entries: SkillTreeEntry[];
  fingerprint: string;
}

function refuseLocalSkill(sourcePath: string, reason: string): never {
  throw new Error(
    `Refusing to install the custom skill ${printable(sourcePath)}: ${reason}.`,
  );
}

async function readLocalSkillTree(
  sourcePath: string,
  directory: string,
): Promise<SkillTreeEntry[]> {
  try {
    return await readSkillTree(directory);
  } catch (error) {
    if (error instanceof SkillTreeRefusal) {
      refuseLocalSkill(sourcePath, error.message);
    }
    throw error;
  }
}

export async function readLocalSkill(
  repoRoot: string,
  sourcePath: string,
  skillName: string,
): Promise<LocalSkill> {
  const repoRelativePath = sourcePath.slice("./".length);
  await resolveInsideRepo(repoRoot, repoRelativePath);
  const directory = await resolveRepoDirectory(repoRoot, repoRelativePath);
  if (directory === null) {
    refuseLocalSkill(sourcePath, "the directory does not exist");
  }

  const entries = await readLocalSkillTree(sourcePath, directory);
  const manifest = entries.find(
    (entry) => entry.relativePath === SKILL_MANIFEST_FILE,
  );
  if (manifest?.contents == null) {
    refuseLocalSkill(sourcePath, `it has no ${SKILL_MANIFEST_FILE}`);
  }
  assertSkillManifestName(
    manifest.contents.toString("utf8"),
    skillName,
    sourcePath,
  );
  return { entries, fingerprint: fingerprintSkillTree(entries) };
}

export async function writeStagedSkill(
  stageDirectory: string,
  skillName: string,
  skill: LocalSkill,
): Promise<string> {
  const skillDirectory = join(stageDirectory, skillName);
  await mkdir(skillDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  for (const entry of skill.entries) {
    const targetPath = join(skillDirectory, entry.relativePath);
    if (entry.contents === null) {
      await mkdir(targetPath, { mode: PRIVATE_DIRECTORY_MODE });
    } else {
      await writeFile(targetPath, entry.contents, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
    }
  }
  return skillDirectory;
}

export async function withSkillsStage<Result>(
  work: (stageDirectory: string) => Promise<Result>,
): Promise<Result> {
  const stageRoot = await preparePrivateStateDirectory(STAGE_DIRECTORY_NAME);
  const stageDirectory = await mkdtemp(join(stageRoot, "run-"));
  try {
    return await work(stageDirectory);
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}
