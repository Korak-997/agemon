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

export type AgentModel = "haiku" | "sonnet" | "opus";

export type AgentEffort = "low" | "medium" | "high";

export interface AgentDefinition {
  name: string;
  fileStem?: string;
  description: string;
  tools: readonly string[];
  model?: AgentModel;
  effort?: AgentEffort;
  maxTurns?: number;
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
const GEO_AUDIT_AGENT_MODEL: AgentModel = "sonnet";

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
    model: GEO_AUDIT_AGENT_MODEL,
    get briefPath() {
      return join(
        resolveVendoredSkillPath("geo-seo", "geo-audit"),
        "references",
        briefFileName,
      );
    },
  };
}

type RoleAgentOptions = Pick<
  AgentDefinition,
  "fileStem" | "effort" | "maxTurns"
>;

const READ_ONLY_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
const SEARCH_AGENT_LIMITS: RoleAgentOptions = {
  effort: "medium",
  maxTurns: 30,
};
const WORKER_AGENT_LIMITS: RoleAgentOptions = {
  effort: "medium",
  maxTurns: 50,
};

function workflowRoleAgent(
  name: string,
  briefFileName: string,
  description: string,
  tools: readonly string[],
  model: AgentModel,
  options: RoleAgentOptions,
): AgentDefinition {
  return {
    name,
    description,
    tools,
    model,
    ...options,
    get briefPath() {
      return join(
        resolveVendoredSkillPath(
          "workflow",
          "agemon-subagent-driven-development",
        ),
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
      "agemon-design: a staged UI workflow that reads your real brand, builds from the subject, and reports what it could not verify. Auto-triggering is not guaranteed, its gates are voluntary, and a passing run does not mean a good design.",
    defaultSelected: false,
    skills: [vendoredSkill("design", "agemon-design")],
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
      vendoredSkill("code-quality", "agemon-unused-code-check"),
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
    agents: [
      workflowRoleAgent(
        "agemon-scout",
        "role-scout.md",
        "Use proactively for read-only searches that would pull many files or long logs into the conversation: finding code, tracing usages, digesting logs. Runs on the cheapest model and reports paths and lines; changes nothing.",
        READ_ONLY_TOOLS,
        "haiku",
        SEARCH_AGENT_LIMITS,
      ),
      workflowRoleAgent(
        "agemon-worker",
        "role-worker.md",
        "Use for one well-defined implementation task or routine review whose spec is already written. Runs on the mid-tier model and hands back anything that needs a design decision.",
        [...READ_ONLY_TOOLS, "Edit", "Write", "Bash"],
        "sonnet",
        WORKER_AGENT_LIMITS,
      ),
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
  {
    id: "nuxt-vue",
    label: "Nuxt / Vue",
    description:
      "Vue 3, Nuxt, Nitro, Pinia, Vite, Vitest and UnoCSS reference skills generated from each project's docs at a pinned commit. They describe the versions current at that commit (Nuxt 5); check your project's versions.",
    defaultSelected: false,
    skills: [
      vendoredSkill("nuxt-vue", "agemon-vue"),
      vendoredSkill("nuxt-vue", "agemon-nuxt"),
      vendoredSkill("nuxt-vue", "agemon-nitro"),
      vendoredSkill("nuxt-vue", "agemon-pinia"),
      vendoredSkill("nuxt-vue", "agemon-vite"),
      vendoredSkill("nuxt-vue", "agemon-vitest"),
      vendoredSkill("nuxt-vue", "agemon-unocss"),
    ],
  },
  {
    id: "browser-testing",
    label: "Browser Testing",
    description:
      "Test a local web app in a real browser by writing Python Playwright scripts: start the dev server, inspect the rendered page, capture screenshots and console logs. Needs Python 3 and Playwright with its browsers, which agemon does not install. The agent runs Python and your server commands, so expect permission prompts.",
    defaultSelected: false,
    skills: [vendoredSkill("browser-testing", "agemon-webapp-testing")],
  },
  {
    id: "motion",
    label: "Motion",
    description:
      "Motion design for UI animation: timing, easing, choreography and Disney principles adapted for interfaces, for CSS, Framer Motion, GSAP, Lottie or any animation system.",
    defaultSelected: false,
    skills: [vendoredSkill("motion", "agemon-motion-design")],
  },
];

export const CORE_AGENTS: readonly AgentDefinition[] = [
  workflowRoleAgent(
    "Explore",
    "role-scout.md",
    "Fast read-only codebase exploration: finds files, traces usages and answers where/how questions. Reports paths and lines with a short summary; changes nothing.",
    READ_ONLY_TOOLS,
    "haiku",
    { ...SEARCH_AGENT_LIMITS, fileStem: "explore" },
  ),
];

export const RETIRED_AGENT_NAMES: readonly string[] = [];

export const RETIRED_SKILL_NAMES: readonly string[] = [
  "agemon-design-minimal",
  "agemon-design-editorial",
  "agemon-design-dashboard",
];

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
