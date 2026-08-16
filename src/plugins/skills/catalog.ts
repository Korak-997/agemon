import { resolveVendoredSkillPath } from "./vendored-path.js";

export interface SkillBundleEntry {
  id: string;
  source: string;
  skillName: string;
  agent: string;
}

export interface SkillGroup {
  id: string;
  label: string;
  description: string;
  /** True only for the group installed unconditionally, with no prompt. */
  defaultSelected: boolean;
  skills: SkillBundleEntry[];
}

function vendoredSkill(groupId: string, skillId: string): SkillBundleEntry {
  return {
    id: skillId,
    source: resolveVendoredSkillPath(groupId, skillId),
    skillName: skillId,
    agent: "claude-code",
  };
}

export const SKILL_GROUPS: SkillGroup[] = [
  {
    id: "essentials",
    label: "Essentials",
    description: "Web design and writing guidelines from Vercel Labs.",
    defaultSelected: true,
    skills: [
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
    ],
  },
  {
    id: "design",
    label: "Design & UI/UX",
    description:
      "agemon-design: design engineering with anti-slop rules, discovery, and outcome recipes for dashboards, landings, and auth screens.",
    defaultSelected: false,
    skills: [
      vendoredSkill("design", "agemon-design"),
      vendoredSkill("design", "agemon-design-minimal"),
      vendoredSkill("design", "agemon-design-editorial"),
      vendoredSkill("design", "agemon-design-dashboard"),
    ],
  },
  {
    id: "security",
    label: "Security",
    description:
      "Exploit-driven security review — no finding without a working proof-of-concept, CVSS-aligned severity.",
    defaultSelected: false,
    skills: [vendoredSkill("security", "agemon-security")],
  },
  {
    id: "code-quality",
    label: "Code Quality",
    description:
      "Simplicity, DRY architecture, self-documenting naming, and surgical scope control for day-to-day edits.",
    defaultSelected: false,
    skills: [
      vendoredSkill("code-quality", "agemon-clean-code"),
      vendoredSkill("code-quality", "agemon-house-rules"),
    ],
  },
  {
    id: "architecture",
    label: "Code Architecture",
    description:
      "Clean Architecture review: dependency rule, layer separation, boundary crossing, SOLID.",
    defaultSelected: false,
    skills: [vendoredSkill("architecture", "agemon-architecture")],
  },
  {
    id: "self-review",
    label: "Self-Review",
    description:
      "Verification before claiming completion, giving and receiving code review, and root-cause-first debugging.",
    defaultSelected: false,
    skills: [
      vendoredSkill("self-review", "agemon-verify-before-done"),
      vendoredSkill("self-review", "agemon-review-intake"),
      vendoredSkill("self-review", "agemon-review-request"),
      vendoredSkill("self-review", "agemon-root-cause"),
    ],
  },
  {
    id: "performance",
    label: "Performance",
    description:
      "Algorithmic-complexity-first discipline: N+1 detection, hot-loop hygiene, and when not to optimize.",
    defaultSelected: false,
    skills: [vendoredSkill("performance", "agemon-performance")],
  },
];

export function findSkillGroup(groupId: string): SkillGroup | undefined {
  return SKILL_GROUPS.find((group) => group.id === groupId);
}
