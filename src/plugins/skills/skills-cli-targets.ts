import { lstat, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isPlainSkillName } from "../../core/config.js";
import { RefusedPathError } from "../../core/files.js";
import { resolveRepoDirectory } from "../../core/repo-paths.js";
import { printable } from "../../core/untrusted-text.js";

export const CANONICAL_SKILLS_DIRECTORY = ".agents/skills";
export const CLAUDE_SKILLS_DIRECTORY = ".claude/skills";
export const SKILLS_LOCK_FILE = "skills-lock.json";

async function lstatIfPresent(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function refuse(relativePath: string, reason: string): never {
  throw new RefusedPathError(
    `Refusing to run the skills CLI: ${printable(relativePath)} ${reason}. agemon only lets it write inside the repository — replace it with a real directory or file.`,
  );
}

function assertPlainSkillName(skillName: string): void {
  if (!isPlainSkillName(skillName)) {
    throw new RefusedPathError(
      `Refusing to run the skills CLI: the skill name '${printable(skillName)}' is not a plain skill name. The ledger in .agemon/state.json may have been edited; check it before running agemon again.`,
    );
  }
}

export async function assertSkillsCliTargetsStayInRepo(
  repoRoot: string,
  skillNames: string[],
  options: { create: boolean },
): Promise<void> {
  skillNames.forEach(assertPlainSkillName);
  const canonicalDirectory = await resolveRepoDirectory(
    repoRoot,
    CANONICAL_SKILLS_DIRECTORY,
    { create: false },
  );
  await resolveRepoDirectory(repoRoot, CLAUDE_SKILLS_DIRECTORY, options);

  if (canonicalDirectory !== null) {
    for (const skillName of skillNames) {
      const stats = await lstatIfPresent(join(canonicalDirectory, skillName));
      if (stats?.isSymbolicLink()) {
        refuse(`${CANONICAL_SKILLS_DIRECTORY}/${skillName}`, "is a symlink");
      }
    }
  }

  const lockStats = await lstatIfPresent(join(repoRoot, SKILLS_LOCK_FILE));
  if (lockStats !== null && !lockStats.isFile()) {
    refuse(SKILLS_LOCK_FILE, "is a symlink or not a regular file");
  }
}

export async function removeInstalledSkillCopy(
  repoRoot: string,
  skillName: string,
): Promise<void> {
  assertPlainSkillName(skillName);
  const skillsDirectory = await resolveRepoDirectory(
    repoRoot,
    CLAUDE_SKILLS_DIRECTORY,
  );
  if (skillsDirectory === null) {
    return;
  }
  const copyPath = join(skillsDirectory, skillName);
  const stats = await lstatIfPresent(copyPath);
  if (stats?.isSymbolicLink()) {
    await unlink(copyPath);
  } else if (stats !== null) {
    await rm(copyPath, { recursive: true, force: true });
  }
}
