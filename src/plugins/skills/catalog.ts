import { join } from "node:path";
import type { CustomSkillGroupConfig } from "../../core/config.js";
import { resolveVendoredSkillPath } from "../../core/package-assets.js";
import { printable } from "../../core/untrusted-text.js";
import {
  type PinnedSkillsRepository,
  resolvePinnedSkillPath,
} from "./pinned-source.js";

export interface SkillBundleEntry {
  id: string;
  readonly source: string;
  skillName: string;
  agent: string;
  pinnedRepository?: PinnedSkillsRepository;
  localSourcePath?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: readonly string[];
  readonly briefPath: string;
}

export interface SkillGroup {
  id: string;
  label: string;
  description: string;
  defaultSelected: boolean;
  definedByRepository?: boolean;
  skills: SkillBundleEntry[];
  agents?: AgentDefinition[];
}

const GEO_AUDIT_AGENT_DESCRIPTION_SUFFIX =
  "Used by the geo-audit skill; do not use it for other tasks.";

function vendoredSkill(groupId: string, skillId: string): SkillBundleEntry {
  return {
    id: skillId,
    get source() {
      return resolveVendoredSkillPath(groupId, skillId);
    },
    skillName: skillId,
    agent: "claude-code",
  };
}

function pinnedSkill(
  repository: PinnedSkillsRepository,
  skillId: string,
): SkillBundleEntry {
  return {
    id: skillId,
    get source() {
      return resolvePinnedSkillPath(repository, skillId);
    },
    skillName: skillId,
    agent: "claude-code",
    pinnedRepository: repository,
  };
}

function geoAuditAgent(
  name: string,
  briefFileName: string,
  purpose: string,
  tools: readonly string[],
): AgentDefinition {
  return {
    name,
    description: `${purpose} ${GEO_AUDIT_AGENT_DESCRIPTION_SUFFIX}`,
    tools,
    get briefPath() {
      return join(
        resolveVendoredSkillPath("geo-seo", "geo-audit"),
        "references",
        briefFileName,
      );
    },
  };
}

export const SKILL_GROUPS: SkillGroup[] = [
  {
    id: "essentials",
    label: "Essentials",
    description: "Web design and writing guidelines from Vercel Labs.",
    defaultSelected: true,
    skills: [
      vendoredSkill("essentials", "web-design-guidelines"),
      vendoredSkill("essentials", "writing-guidelines"),
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
      "Exploit-driven security review — no finding without a working proof-of-concept, CVSS-aligned severity — plus a multi-agent, multi-phase codebase audit with independently verified findings.",
    defaultSelected: false,
    skills: [
      vendoredSkill("security", "agemon-security"),
      vendoredSkill("security", "agemon-security-audit"),
    ],
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
  {
    id: "commit",
    label: "Commit Hygiene",
    description:
      "Staging review, commit message structure, and splitting unrelated changes into separate commits.",
    defaultSelected: false,
    skills: [vendoredSkill("commit", "agemon-commit")],
  },
  {
    id: "teamlead",
    label: "Team Lead",
    description:
      "Team-lead workflows: RFC planning, PRD generation/decomposition, meeting lifecycle, task extraction, tech spikes, IT audits, incident RCA, security checks, tech-lead review, and Obsidian vault sync.",
    defaultSelected: false,
    skills: [
      vendoredSkill("team-lead", "agemon-plan-rfc"),
      vendoredSkill("team-lead", "prd-generator"),
      vendoredSkill("team-lead", "skill-headofit-audit"),
      vendoredSkill("team-lead", "skill-incident-rca"),
      vendoredSkill("team-lead", "skill-meeting-lifecycle"),
      vendoredSkill("team-lead", "skill-obsidian-vault-sync"),
      vendoredSkill("team-lead", "skill-prd-decomposer"),
      vendoredSkill("team-lead", "skill-sec-check"),
      vendoredSkill("team-lead", "skill-task-extractor"),
      vendoredSkill("team-lead", "skill-techlead-reviewer"),
      vendoredSkill("team-lead", "skill-tech-spike"),
    ],
  },
  {
    id: "geo-seo",
    label: "GEO / AI Search SEO",
    description:
      "Audit and optimize websites for AI search citation (ChatGPT, Perplexity, Google AI Overviews): citability, AI crawlers, llms.txt, schema, technical SEO, reports.",
    defaultSelected: false,
    skills: [
      vendoredSkill("geo-seo", "geo"),
      vendoredSkill("geo-seo", "geo-audit"),
      vendoredSkill("geo-seo", "geo-citability"),
      vendoredSkill("geo-seo", "geo-crawlers"),
      vendoredSkill("geo-seo", "geo-llmstxt"),
      vendoredSkill("geo-seo", "geo-brand-mentions"),
      vendoredSkill("geo-seo", "geo-platform-optimizer"),
      vendoredSkill("geo-seo", "geo-technical"),
      vendoredSkill("geo-seo", "geo-content"),
      vendoredSkill("geo-seo", "geo-report"),
      vendoredSkill("geo-seo", "geo-schema"),
      vendoredSkill("geo-seo", "geo-report-pdf"),
    ],
    agents: [
      geoAuditAgent(
        "geo-audit-ai-visibility",
        "ai-visibility.md",
        "Scores how quotable and visible a website is to AI search: citability, AI crawler access, llms.txt and brand presence.",
        ["WebFetch"],
      ),
      geoAuditAgent(
        "geo-audit-platform",
        "platform-analysis.md",
        "Scores a website's readiness for Google AI Overviews, ChatGPT, Perplexity, Gemini and Bing Copilot.",
        ["WebFetch"],
      ),
      geoAuditAgent(
        "geo-audit-technical",
        "technical.md",
        "Scores a website's technical health for AI crawlers: rendering, meta tags, headers, speed and security headers.",
        ["WebFetch", "Bash"],
      ),
      geoAuditAgent(
        "geo-audit-content",
        "content.md",
        "Scores a website's content quality and E-E-A-T signals: experience, expertise, authority and trust.",
        ["WebFetch"],
      ),
      geoAuditAgent(
        "geo-audit-schema",
        "schema.md",
        "Scores a website's schema.org structured data and finds missing GEO-relevant schema.",
        ["WebFetch", "Bash"],
      ),
    ],
  },
  {
    id: "workflow",
    label: "Development Workflow",
    description:
      "Structured feature delivery: brainstorming, written plans, test-driven development, subagent or inline execution, git worktrees, and branch finishing. Pairs with Self-Review.",
    defaultSelected: false,
    skills: [
      vendoredSkill("workflow", "agemon-brainstorming"),
      vendoredSkill("workflow", "agemon-writing-plans"),
      vendoredSkill("workflow", "agemon-executing-plans"),
      vendoredSkill("workflow", "agemon-subagent-driven-development"),
      vendoredSkill("workflow", "agemon-test-driven-development"),
      vendoredSkill("workflow", "agemon-using-git-worktrees"),
      vendoredSkill("workflow", "agemon-dispatching-parallel-agents"),
      vendoredSkill("workflow", "agemon-finishing-a-development-branch"),
    ],
  },
  {
    id: "output-style",
    label: "Output Style",
    description:
      "agemon-adhd: on request, replies lead with the next action, number their steps, restate progress, and skip preamble and tangents.",
    defaultSelected: false,
    skills: [vendoredSkill("output-style", "agemon-adhd")],
  },
  {
    id: "founder",
    label: "Founder",
    description:
      "Test a business idea before launch: board review, competitors, simulated buyer panel, pricing, offer, unit economics, marketing, brand, operations, launch, and a business plan with a computed verdict.",
    defaultSelected: false,
    skills: [
      vendoredSkill("founder", "agemon-founder-board"),
      vendoredSkill("founder", "agemon-founder-competitors"),
      vendoredSkill("founder", "agemon-founder-consumer"),
      vendoredSkill("founder", "agemon-founder-pricing"),
      vendoredSkill("founder", "agemon-founder-offer"),
      vendoredSkill("founder", "agemon-founder-cfo"),
      vendoredSkill("founder", "agemon-founder-marketing"),
      vendoredSkill("founder", "agemon-founder-brand"),
      vendoredSkill("founder", "agemon-founder-ops"),
      vendoredSkill("founder", "agemon-founder-launch"),
      vendoredSkill("founder", "agemon-founder-plan"),
    ],
  },
];

export const RETIRED_AGENT_NAMES: readonly string[] = [];

export function findSkillGroup(groupId: string): SkillGroup | undefined {
  return SKILL_GROUPS.find((group) => group.id === groupId);
}

const CUSTOM_GROUP_DESCRIPTION =
  "Defined in this repository's agemon.toml, not by agemon.";

function localSkill(path: string, skillName: string): SkillBundleEntry {
  return {
    id: skillName,
    source: path,
    skillName,
    agent: "claude-code",
    localSourcePath: path,
  };
}

function failCustomGroups(detail: string): never {
  throw new Error(`agemon.toml is invalid: ${printable(detail)}`);
}

export function buildCustomSkillGroups(
  configs: CustomSkillGroupConfig[],
): SkillGroup[] {
  const builtInSkillNames = new Set(
    SKILL_GROUPS.flatMap((group) =>
      group.skills.map((skill) => skill.skillName),
    ),
  );
  return configs.map((config) => {
    if (findSkillGroup(config.id) !== undefined) {
      failCustomGroups(
        `custom_skill_groups.${config.id} uses the id of a built-in skill group`,
      );
    }
    return {
      id: config.id,
      label: config.label,
      description: CUSTOM_GROUP_DESCRIPTION,
      defaultSelected: false,
      definedByRepository: true,
      skills: config.skills.map((skill) => {
        if (builtInSkillNames.has(skill.skillName)) {
          failCustomGroups(
            `custom_skill_groups.${config.id} names '${skill.skillName}', which is a built-in skill`,
          );
        }
        return skill.kind === "local"
          ? localSkill(skill.path, skill.skillName)
          : pinnedSkill(
              {
                url: `https://github.com/${skill.owner}/${skill.repository}`,
                commit: skill.ref,
              },
              skill.skillName,
            );
      }),
    };
  });
}

export function assertCustomSkillGroupsAreValid(
  configs: CustomSkillGroupConfig[],
): void {
  buildCustomSkillGroups(configs);
}
