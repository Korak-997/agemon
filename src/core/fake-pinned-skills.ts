import { fingerprintSkillTree } from "../plugins/skills/skill-tree.js";
import { isDevMode } from "./dev-mode.js";

export const FAKE_PINNED_SKILL_MANIFEST_FILE = "SKILL.md";

export function fakePinnedSkillManifest(skillName: string): string {
  return `---\nname: ${skillName}\ndescription: Stand-in for the pinned ${skillName} skill, written by agemon's fake git backend.\n---\n\nFake ${skillName}.\n`;
}

export function fakePinnedSkillFingerprint(skillName: string): string {
  return fingerprintSkillTree([
    {
      relativePath: FAKE_PINNED_SKILL_MANIFEST_FILE,
      contents: Buffer.from(fakePinnedSkillManifest(skillName)),
    },
  ]);
}

export function fakeSubprocessesActive(): boolean {
  return process.env.AGEMON_FAKE_SUBPROCESS === "1" && isDevMode();
}
