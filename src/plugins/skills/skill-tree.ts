import { constants, type Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintJson, sha256Hex } from "../../core/fingerprint.js";
import { printable } from "../../core/untrusted-text.js";

const MAX_SKILL_ENTRIES = 200;
const MAX_SKILL_DEPTH = 8;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const FINDER_METADATA_FILE = ".DS_Store";

export const SKILLS_CLI_COPY_EXCLUSIONS = {
  anyName: ["metadata.json"],
  directoryNames: [".git", "__pycache__", "__pypackages__"],
} as const;

export class SkillTreeRefusal extends Error {}

export interface SkillTreeEntry {
  relativePath: string;
  contents: Buffer | null;
}

type SkipEntry = (name: string, stats: Stats) => boolean;

const keepEveryEntry: SkipEntry = () => false;

export function isLeftOutBySkillsCli(name: string, stats: Stats): boolean {
  return (
    (SKILLS_CLI_COPY_EXCLUSIONS.anyName as readonly string[]).includes(name) ||
    (stats.isDirectory() &&
      (SKILLS_CLI_COPY_EXCLUSIONS.directoryNames as readonly string[]).includes(
        name,
      ))
  );
}

function isFinderMetadataFile(name: string, stats: Stats): boolean {
  return name === FINDER_METADATA_FILE && stats.isFile();
}

async function readRegularFileWithoutFollowing(
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
      throw new SkillTreeRefusal("it is larger than 8 MiB");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function sortedNamesUpToCap(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    names.push(entry.name);
    if (names.length > MAX_SKILL_ENTRIES) {
      throw new SkillTreeRefusal(
        `it has more than ${MAX_SKILL_ENTRIES} entries`,
      );
    }
  }
  return names.sort();
}

export async function readSkillTree(
  directory: string,
  skipEntry: SkipEntry = keepEveryEntry,
): Promise<SkillTreeEntry[]> {
  const entries: SkillTreeEntry[] = [];
  let totalBytes = 0;

  const walk = async (relativeDirectory: string, depth: number) => {
    if (depth > MAX_SKILL_DEPTH) {
      throw new SkillTreeRefusal(
        `it is nested deeper than ${MAX_SKILL_DEPTH} levels`,
      );
    }
    for (const name of await sortedNamesUpToCap(
      join(directory, relativeDirectory),
    )) {
      const relativePath =
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const absolutePath = join(directory, relativePath);
      const stats = await lstat(absolutePath);
      if (skipEntry(name, stats)) {
        continue;
      }
      if (entries.length >= MAX_SKILL_ENTRIES) {
        throw new SkillTreeRefusal(
          `it has more than ${MAX_SKILL_ENTRIES} entries`,
        );
      }
      if (stats.isDirectory()) {
        entries.push({ relativePath, contents: null });
        await walk(relativePath, depth + 1);
        continue;
      }
      const contents = stats.isFile()
        ? await readRegularFileWithoutFollowing(
            absolutePath,
            MAX_SKILL_BYTES - totalBytes,
          )
        : null;
      if (contents === null) {
        throw new SkillTreeRefusal(
          `${printable(relativePath)} is a symlink or not a regular file`,
        );
      }
      totalBytes += contents.length;
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new SkillTreeRefusal("it is larger than 8 MiB");
      }
      entries.push({ relativePath, contents });
    }
  };

  await walk("", 1);
  return entries;
}

export function fingerprintSkillTree(entries: SkillTreeEntry[]): string {
  return fingerprintJson(
    entries.map((entry) => [
      entry.relativePath,
      entry.contents === null ? null : sha256Hex(entry.contents),
    ]),
  );
}

export async function fingerprintSkillSource(
  directory: string,
): Promise<string> {
  return fingerprintSkillTree(
    await readSkillTree(directory, isLeftOutBySkillsCli),
  );
}

export async function fingerprintInstalledSkill(
  directory: string,
): Promise<string> {
  return fingerprintSkillTree(
    await readSkillTree(directory, isFinderMetadataFile),
  );
}
