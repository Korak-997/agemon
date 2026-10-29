import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fingerprintJson, sha256Hex } from "../../core/fingerprint.js";
import {
  resolveInsideRepo,
  resolveRepoDirectory,
} from "../../core/repo-paths.js";
import { preparePrivateStateDirectory } from "../../core/state-root.js";
import { printable } from "../../core/untrusted-text.js";
import { assertSkillManifestName } from "./skill-manifest.js";

const MAX_SKILL_ENTRIES = 200;
const MAX_SKILL_DEPTH = 8;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const SKILL_MANIFEST_FILE = "SKILL.md";
const STAGE_DIRECTORY_NAME = "skills-stage";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

interface SkillTreeEntry {
  relativePath: string;
  contents: Buffer | null;
}

export interface LocalSkill {
  entries: SkillTreeEntry[];
  fingerprint: string;
}

function refuseLocalSkill(sourcePath: string, reason: string): never {
  throw new Error(
    `Refusing to install the custom skill ${printable(sourcePath)}: ${reason}.`,
  );
}

async function readRegularFileWithoutFollowing(
  sourcePath: string,
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > maxBytes) {
      refuseLocalSkill(sourcePath, "it is larger than 8 MiB");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readSkillTree(
  sourcePath: string,
  directory: string,
): Promise<SkillTreeEntry[]> {
  const entries: SkillTreeEntry[] = [];
  let totalBytes = 0;

  const walk = async (relativeDirectory: string, depth: number) => {
    if (depth > MAX_SKILL_DEPTH) {
      refuseLocalSkill(
        sourcePath,
        `it is nested deeper than ${MAX_SKILL_DEPTH} levels`,
      );
    }
    const names = (await readdir(join(directory, relativeDirectory))).sort();
    for (const name of names) {
      const relativePath =
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      if (entries.length >= MAX_SKILL_ENTRIES) {
        refuseLocalSkill(
          sourcePath,
          `it has more than ${MAX_SKILL_ENTRIES} entries`,
        );
      }
      const absolutePath = join(directory, relativePath);
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        entries.push({ relativePath, contents: null });
        await walk(relativePath, depth + 1);
        continue;
      }
      const contents = stats.isFile()
        ? await readRegularFileWithoutFollowing(
            sourcePath,
            absolutePath,
            MAX_SKILL_BYTES - totalBytes,
          )
        : null;
      if (contents === null) {
        refuseLocalSkill(
          sourcePath,
          `${printable(relativePath)} is a symlink or not a regular file`,
        );
      }
      totalBytes += contents.length;
      if (totalBytes > MAX_SKILL_BYTES) {
        refuseLocalSkill(sourcePath, "it is larger than 8 MiB");
      }
      entries.push({ relativePath, contents });
    }
  };

  await walk("", 1);
  return entries;
}

function fingerprintSkillTree(entries: SkillTreeEntry[]): string {
  return fingerprintJson(
    entries.map((entry) => [
      entry.relativePath,
      entry.contents === null ? null : sha256Hex(entry.contents),
    ]),
  );
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

  const entries = await readSkillTree(sourcePath, directory);
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
