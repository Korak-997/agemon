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
  routeHint?: string;
}

export const MAX_ROUTE_HINT_LENGTH = 110;

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

function vendoredSkill(
  groupId: string,
  skillId: string,
  routeHint: string,
): SkillBundleEntry {
  return {
    id: skillId,
    get source() {
      return resolveVendoredSkillPath(groupId, skillId);
    },
    skillName: skillId,
    agent: "claude-code",
    routeHint,
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
      vendoredSkill(
        "essentials",
        "web-design-guidelines",
        "Reviewing UI code for accessibility, UX and Web Interface Guidelines compliance",
      ),
      vendoredSkill(
        "essentials",
        "writing-guidelines",
        "Reviewing docs or prose for style, voice and tone",
      ),
    ],
  },
  {
    id: "design",
    label: "Design & UI/UX",
    description:
      "agemon-design: a staged UI workflow that reads your real brand, builds from the subject, and reports what it could not verify. Auto-triggering is not guaranteed, its gates are voluntary, and a passing run does not mean a good design.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "design",
        "agemon-design",
        "Creating, restyling or reviewing any user interface, including small visual changes",
      ),
    ],
  },
  {
    id: "security",
    label: "Security",
    description:
      "Exploit-driven security review — no finding without a working proof-of-concept, CVSS-aligned severity — plus a multi-agent, multi-phase codebase audit with independently verified findings.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "security",
        "agemon-security",
        "Finding security issues in code that handles user input, commands, files or network requests",
      ),
      vendoredSkill(
        "security",
        "agemon-security-audit",
        "A full security audit, pen test or vulnerability review of a codebase, API or service",
      ),
    ],
  },
  {
    id: "code-quality",
    label: "Code Quality",
    description:
      "Simplicity, DRY architecture, self-documenting naming, and surgical scope control for day-to-day edits.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "code-quality",
        "agemon-clean-code",
        "Writing, reviewing or refactoring code without overcomplication or unstated assumptions",
      ),
      vendoredSkill(
        "code-quality",
        "agemon-house-rules",
        "Writing or editing code that must stay minimal, readable and traceable to the request",
      ),
      vendoredSkill(
        "code-quality",
        "agemon-unused-code-check",
        "Finding unused files, exports or dependencies in a JavaScript or TypeScript project",
      ),
    ],
  },
  {
    id: "architecture",
    label: "Code Architecture",
    description:
      "Clean Architecture review: dependency rule, layer separation, boundary crossing, SOLID.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "architecture",
        "agemon-architecture",
        "Reviewing architecture or dependencies against Clean Architecture and SOLID",
      ),
    ],
  },
  {
    id: "self-review",
    label: "Self-Review",
    description:
      "Verification before claiming completion, giving and receiving code review, and root-cause-first debugging.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "self-review",
        "agemon-verify-before-done",
        "About to claim work is complete, fixed or passing, before committing or opening a PR",
      ),
      vendoredSkill(
        "self-review",
        "agemon-review-intake",
        "Code review feedback, before implementing the suggestions",
      ),
      vendoredSkill(
        "self-review",
        "agemon-review-request",
        "A finished task or major feature, before merging, to check it meets requirements",
      ),
      vendoredSkill(
        "self-review",
        "agemon-root-cause",
        "A bug, failing test or unexpected behavior, before proposing a fix",
      ),
    ],
  },
  {
    id: "performance",
    label: "Performance",
    description:
      "Algorithmic-complexity-first discipline: N+1 detection, hot-loop hygiene, and when not to optimize.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "performance",
        "agemon-performance",
        "Writing or reviewing loops, queries, API handlers or rendering paths that run repeatedly",
      ),
    ],
  },
  {
    id: "commit",
    label: "Commit Hygiene",
    description:
      "Staging review, commit message structure, and splitting unrelated changes into separate commits.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "commit",
        "agemon-commit",
        "Writing a commit message or preparing a commit, including splitting unrelated changes",
      ),
    ],
  },
  {
    id: "nuxt-vue",
    label: "Nuxt / Vue",
    description:
      "Vue 3, Nuxt, Nitro, Pinia, Vite, Vitest and UnoCSS reference skills generated from each project's docs at a pinned commit. They describe the versions current at that commit (Nuxt 5); check your project's versions.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "nuxt-vue",
        "agemon-vue",
        "Vue 3 components with the Composition API, script setup macros, reactivity or watchers",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-nuxt",
        "A Nuxt app: server routes, useFetch, middleware, auto-imports or hybrid rendering",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-nitro",
        "Nitro server routes, event handlers, route rules, caching, storage or deployment",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-pinia",
        "Pinia stores: state, getters, actions and store patterns in Vue apps",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-vite",
        "Vite configuration, Vite plugins, SSR or library builds",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-vitest",
        "Writing Vitest tests, mocks, fixtures or coverage configuration",
      ),
      vendoredSkill(
        "nuxt-vue",
        "agemon-unocss",
        "UnoCSS configuration, utility rules, shortcuts or presets",
      ),
    ],
  },
  {
    id: "browser-testing",
    label: "Browser Testing",
    description:
      "Test a local web app in a real browser by writing Python Playwright scripts: start the dev server, inspect the rendered page, capture screenshots and console logs. Needs Python 3 and Playwright with its browsers, which agemon does not install. The agent runs Python and your server commands, so expect permission prompts.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "browser-testing",
        "agemon-webapp-testing",
        "Testing a local web app in a real browser: UI behavior, screenshots or console logs",
      ),
    ],
  },
  {
    id: "teamlead",
    label: "Team Lead",
    description:
      "Team-lead workflows: RFC planning, PRD generation/decomposition, meeting lifecycle, task extraction, tech spikes, IT audits, incident RCA, security checks, tech-lead review, and Obsidian vault sync.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "team-lead",
        "agemon-plan-rfc",
        "Proposing a major feature or architectural change that needs an RFC and stakeholder buy-in",
      ),
      vendoredSkill(
        "team-lead",
        "prd-generator",
        "Writing a product requirements document (PRD) for a feature",
      ),
      vendoredSkill(
        "team-lead",
        "skill-headofit-audit",
        "Evaluating SaaS tools, cloud costs, self-hosting or vendor lock-in for an IT decision",
      ),
      vendoredSkill(
        "team-lead",
        "skill-incident-rca",
        "A blameless root cause analysis or post-mortem of a production incident or outage",
      ),
      vendoredSkill(
        "team-lead",
        "skill-meeting-lifecycle",
        "Turning a meeting transcript or notes into a summary with decisions and follow-ups",
      ),
      vendoredSkill(
        "team-lead",
        "skill-obsidian-vault-sync",
        "Formatting notes, plans or tasks as linked Obsidian vault notes",
      ),
      vendoredSkill(
        "team-lead",
        "skill-prd-decomposer",
        "Breaking a PRD or spec into epics and user stories with acceptance criteria",
      ),
      vendoredSkill(
        "team-lead",
        "skill-sec-check",
        "A DevSecOps pre-flight check of a design, diff or dependencies for OWASP risks and leaked secrets",
      ),
      vendoredSkill(
        "team-lead",
        "skill-task-extractor",
        "Extracting tasks, owners and deadlines from transcripts, notes or discussion threads",
      ),
      vendoredSkill(
        "team-lead",
        "skill-techlead-reviewer",
        "A tech-lead pull request review: architecture fit, anti-patterns, performance and tests",
      ),
      vendoredSkill(
        "team-lead",
        "skill-tech-spike",
        "A tech spike: evaluating libraries, integrations or a proof of concept before committing",
      ),
    ],
  },
  {
    id: "geo-seo",
    label: "GEO / AI Search SEO",
    description:
      "Audit and optimize websites for AI search citation (ChatGPT, Perplexity, Google AI Overviews): citability, AI crawlers, llms.txt, schema, technical SEO, reports.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "geo-seo",
        "geo",
        "Optimizing a website for AI search engines and traditional SEO",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-audit",
        "A full GEO and SEO audit of a website with a composite score and action plan",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-citability",
        "Scoring how likely AI systems are to cite a web page, with rewrite suggestions",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-crawlers",
        "Checking which AI crawlers can access a site via robots.txt, meta tags and headers",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-llmstxt",
        "Validating or generating a website's llms.txt file",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-brand-mentions",
        "Scanning a brand's presence on the platforms AI models use for citations",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-platform-optimizer",
        "Optimizing a site for Google AI Overviews, ChatGPT, Perplexity, Gemini or Bing Copilot",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-technical",
        "A technical SEO audit: crawlability, indexability, performance, SSR and AI crawler access",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-content",
        "Assessing content quality and E-E-A-T for AI citability",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-report",
        "Combining GEO audit results into a client-facing report",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-schema",
        "Auditing or generating schema.org JSON-LD structured data",
      ),
      vendoredSkill(
        "geo-seo",
        "geo-report-pdf",
        "Turning a GEO audit report into a styled, client-ready PDF",
      ),
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
      vendoredSkill(
        "workflow",
        "agemon-brainstorming",
        "Any creative work before building it: a new feature, component, behavior change or plan",
      ),
      vendoredSkill(
        "workflow",
        "agemon-writing-plans",
        "A spec or requirements for a multi-step task, before touching code",
      ),
      vendoredSkill(
        "workflow",
        "agemon-executing-plans",
        "Executing an implementation plan yourself in the current session",
      ),
      vendoredSkill(
        "workflow",
        "agemon-subagent-driven-development",
        "Executing an implementation plan of independent tasks with subagents",
      ),
      vendoredSkill(
        "workflow",
        "agemon-test-driven-development",
        "Implementing any feature or bugfix, before writing the implementation code",
      ),
      vendoredSkill(
        "workflow",
        "agemon-using-git-worktrees",
        "Starting feature work that needs a workspace isolated from the current one",
      ),
      vendoredSkill(
        "workflow",
        "agemon-dispatching-parallel-agents",
        "Two or more independent tasks with no shared state or ordering",
      ),
      vendoredSkill(
        "workflow",
        "agemon-finishing-a-development-branch",
        "Finished work with passing tests, deciding how to integrate the branch",
      ),
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
    skills: [
      vendoredSkill(
        "output-style",
        "agemon-adhd",
        "Replies shaped for a reader with ADHD, on the user's request only",
      ),
    ],
  },
  {
    id: "founder",
    label: "Founder",
    description:
      "Test a business idea before launch: board review, competitors, simulated buyer panel, pricing, offer, unit economics, marketing, brand, operations, launch, and a business plan with a computed verdict.",
    defaultSelected: false,
    skills: [
      vendoredSkill(
        "founder",
        "agemon-founder-board",
        "Testing a business idea in front of a simulated board that votes to fund or pass",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-competitors",
        "Mapping a business's competitors, substitutes and the market gap it can own",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-consumer",
        "Running a business pitch past a simulated buyer panel to see who buys and why",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-pricing",
        "Setting a price buyers will pay, with a price ladder and an opening offer",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-offer",
        "Making a business offer stronger with bonuses, a guarantee and real urgency",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-cfo",
        "A business's unit economics: margins, break-even, cash needed and payback",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-marketing",
        "A marketing plan: positioning, channels, a 30-day launch campaign and ads",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-brand",
        "Naming a business and defining its brand voice, tagline and look",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-ops",
        "How a business runs day to day: suppliers, staffing, routines, permits and risks",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-launch",
        "A dated launch plan for a business, from a real-world test to the first 30 days",
      ),
      vendoredSkill(
        "founder",
        "agemon-founder-plan",
        "Compiling the founder skills' outputs into one business plan with a computed verdict",
      ),
    ],
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
