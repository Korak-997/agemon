import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlainSkillName } from "../../src/core/config.js";

const SKILLS_DIRECTORY_BY_LOCATION = {
  claude: ".claude/skills",
  agents: ".agents/skills",
} as const;

export async function seedInstalledSkills(
  repoRoot: string,
  skillNames: readonly string[],
  location: keyof typeof SKILLS_DIRECTORY_BY_LOCATION = "claude",
): Promise<void> {
  for (const skillName of skillNames) {
    if (!isPlainSkillName(skillName)) {
      throw new Error(
        `seedInstalledSkills only writes plain skill names, not ${skillName}`,
      );
    }
    const skillDirectory = join(
      repoRoot,
      SKILLS_DIRECTORY_BY_LOCATION[location],
      skillName,
    );
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      `---\nname: ${skillName}\n---\n`,
      "utf8",
    );
  }
}
