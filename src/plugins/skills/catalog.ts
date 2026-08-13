export interface SkillBundleEntry {
  id: string;
  source: string;
  skillName: string;
  agent: string;
}

export const SKILL_BUNDLE: SkillBundleEntry[] = [
  {
    id: "web-design-guidelines",
    source: "vercel-labs/agent-skills",
    skillName: "web-design-guidelines",
    agent: "claude-code",
  },
  {
    id: "writing-guidelines",
    source: "vercel-labs/agent-skills",
    skillName: "writing-guidelines",
    agent: "claude-code",
  },
];
