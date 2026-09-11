import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureNonInteractiveRun as runCli } from "./cli-harness.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function captureNonInteractiveRun(
  fixtureName: string,
  argv: string[],
): Promise<string> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-noninteractive-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  return runCli(fixtureName, argv, sandboxDirectory);
}

describe("non-interactive output contract", () => {
  it("first non-interactive run previews a plan and stops", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", []),
    ).toMatchInlineSnapshot(`
      "exit 0
      5/5 tools present — python3, pip, pipx, uv, code-review-graph
      Plan <PLAN_ID>   ·   agemon <VERSION>

      crg
        v  code-review-graph        [executes]
             pipx install code-review-graph; build the code graph for this repository

      daemon
        v  agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service [executes]
             register systemd --user unit agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service to keep the code graph fresh

      skills
        v  skill-groups:configured  [executes]
             add the configured skill groups via 'npx skills add'

      cli-tool
        v  agnix                    [executes]
             npm install --global agnix

      master-prompt
        +  AGENTS.md                [writes-config]
             --- AGENTS.md
             +++ AGENTS.md
             +<!-- agemon:start:agent-rules -->
             +# AI Agent Rules
             +
             +This block is the canonical, repo-wide rule set for every AI coding agent in this
             +repository. \`CLAUDE.md\`, \`GEMINI.md\`, \`.cursorrules\`, and \`.windsurfrules\` are pointer
             +files that exist only because their tools look for those exact names — read this first.
             +
             +## Task Lifecycle
             +
             +Apply this sequence to every task:
             +
             +1. Discover existing skills, tools, utilities, and conventions before writing new code.
             +2. Plan the smallest complete change; state assumptions and tradeoffs before implementing.
             +3. Verify assumptions with tests or reproducible checks.
             +4. Implement with clear names, modular boundaries, and no dead code.
             +5. Re-verify after the change and confirm no regressions were introduced.
             +6. Record anything out of scope in \`improvements.md\` instead of fixing it inline.
             +
             +## Core Directives
             +
             +- Simplicity first: the minimum code that solves the problem, nothing speculative.
             +- Reuse existing project utilities instead of duplicating logic.
             +- Match the surrounding code's style, naming, and structure.
             +- Keep every change surgical: touch only what the task requires.
             +- Zero waste in your own changes: no unused imports, variables, or dead branches.
             +- Self-documenting code: descriptive names and named constants over explanatory comments.
             +- Preserve user-authored content outside agemon-managed files and blocks.
             +- Prefer safe, reversible changes; call out irreversible or outward-facing steps first.
             +- Security and performance by default within scope: validate input, least privilege,
             +  no needless recomputation.
             +
             +## Output Conventions
             +
             +- Reference real, existing file paths.
             +- Mark the file path above each changed code block.
             +- End every task with a short summary of what changed and why.
             +<!-- agemon:end:agent-rules -->
        +  CLAUDE.md                [writes-config]
             --- CLAUDE.md
             +++ CLAUDE.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Claude Code looks for \`CLAUDE.md\` specifically; it intentionally does not restate the rules.
        +  GEMINI.md                [writes-config]
             --- GEMINI.md
             +++ GEMINI.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Gemini CLI looks for \`GEMINI.md\` specifically; it intentionally does not restate the rules.
        +  .cursorrules             [writes-config]
             --- .cursorrules
             +++ .cursorrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Cursor looks for \`.cursorrules\` specifically; it intentionally does not restate the rules.
        +  .windsurfrules           [writes-config]
             --- .windsurfrules
             +++ .windsurfrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Windsurf looks for \`.windsurfrules\` specifically; it intentionally does not restate the rules.

      Summary
        3 install · 1 register · 5 create

      Plan written to .agemon/plans/<PLAN_ID>.json
      Review, then re-run interactively or with --yes, or 'agemon apply --plan <PLAN_ID>'."
    `);
  });

  it("--dry-run narrates the plan without applying", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["--dry-run"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      5/5 tools present — python3, pip, pipx, uv, code-review-graph
      Plan <PLAN_ID>   ·   agemon <VERSION>

      crg
        v  code-review-graph        [executes]
             pipx install code-review-graph; build the code graph for this repository

      daemon
        v  agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service [executes]
             register systemd --user unit agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service to keep the code graph fresh

      skills
        v  skill-groups:configured  [executes]
             add the configured skill groups via 'npx skills add'

      cli-tool
        v  agnix                    [executes]
             npm install --global agnix

      master-prompt
        +  AGENTS.md                [writes-config]
             --- AGENTS.md
             +++ AGENTS.md
             +<!-- agemon:start:agent-rules -->
             +# AI Agent Rules
             +
             +This block is the canonical, repo-wide rule set for every AI coding agent in this
             +repository. \`CLAUDE.md\`, \`GEMINI.md\`, \`.cursorrules\`, and \`.windsurfrules\` are pointer
             +files that exist only because their tools look for those exact names — read this first.
             +
             +## Task Lifecycle
             +
             +Apply this sequence to every task:
             +
             +1. Discover existing skills, tools, utilities, and conventions before writing new code.
             +2. Plan the smallest complete change; state assumptions and tradeoffs before implementing.
             +3. Verify assumptions with tests or reproducible checks.
             +4. Implement with clear names, modular boundaries, and no dead code.
             +5. Re-verify after the change and confirm no regressions were introduced.
             +6. Record anything out of scope in \`improvements.md\` instead of fixing it inline.
             +
             +## Core Directives
             +
             +- Simplicity first: the minimum code that solves the problem, nothing speculative.
             +- Reuse existing project utilities instead of duplicating logic.
             +- Match the surrounding code's style, naming, and structure.
             +- Keep every change surgical: touch only what the task requires.
             +- Zero waste in your own changes: no unused imports, variables, or dead branches.
             +- Self-documenting code: descriptive names and named constants over explanatory comments.
             +- Preserve user-authored content outside agemon-managed files and blocks.
             +- Prefer safe, reversible changes; call out irreversible or outward-facing steps first.
             +- Security and performance by default within scope: validate input, least privilege,
             +  no needless recomputation.
             +
             +## Output Conventions
             +
             +- Reference real, existing file paths.
             +- Mark the file path above each changed code block.
             +- End every task with a short summary of what changed and why.
             +<!-- agemon:end:agent-rules -->
        +  CLAUDE.md                [writes-config]
             --- CLAUDE.md
             +++ CLAUDE.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Claude Code looks for \`CLAUDE.md\` specifically; it intentionally does not restate the rules.
        +  GEMINI.md                [writes-config]
             --- GEMINI.md
             +++ GEMINI.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Gemini CLI looks for \`GEMINI.md\` specifically; it intentionally does not restate the rules.
        +  .cursorrules             [writes-config]
             --- .cursorrules
             +++ .cursorrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Cursor looks for \`.cursorrules\` specifically; it intentionally does not restate the rules.
        +  .windsurfrules           [writes-config]
             --- .windsurfrules
             +++ .windsurfrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Windsurf looks for \`.windsurfrules\` specifically; it intentionally does not restate the rules.

      Summary
        3 install · 1 register · 5 create

      Plan written to .agemon/plans/<PLAN_ID>.json
      Review, then re-run interactively or with --yes, or 'agemon apply --plan <PLAN_ID>'."
    `);
  });

  it("--yes applies the plan end to end", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["--yes"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      5/5 tools present — python3, pip, pipx, uv, code-review-graph
      Wrote agemon.toml — commit it so teammates and CI reconcile the same way.
      ╭ [ok] Applied 9 operations · environment verified ──────────────────────╮
      │                                                                        │
      │     code-review-graph  1 operation                                     │
      │     Background service 1 operation                                     │
      │     Skills             1 operation                                     │
      │     CLI tools          1 operation                                     │
      │     Instruction files  5 operations                                    │
      │                                                                        │
      │   Next steps                                                           │
      │     -> commit agemon.toml so teammates and CI reconcile the same way   │
      │                                                                        │
      ╰────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("--quiet prints only the final summary", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["--yes", "--quiet"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      ╭ [ok] Applied 9 operations · environment verified ──────────────────────╮
      │                                                                        │
      │     code-review-graph  1 operation                                     │
      │     Background service 1 operation                                     │
      │     Skills             1 operation                                     │
      │     CLI tools          1 operation                                     │
      │     Instruction files  5 operations                                    │
      │                                                                        │
      │   Next steps                                                           │
      │     -> commit agemon.toml so teammates and CI reconcile the same way   │
      │                                                                        │
      ╰────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("plan writes a fingerprinted plan file and renders it", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["plan"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      Plan <PLAN_ID>   ·   agemon <VERSION>

      crg
        v  code-review-graph        [executes]
             pipx install code-review-graph; build the code graph for this repository

      daemon
        v  agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service [executes]
             register systemd --user unit agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service to keep the code graph fresh

      skills
        v  skill-groups:configured  [executes]
             add the configured skill groups via 'npx skills add'

      cli-tool
        v  agnix                    [executes]
             npm install --global agnix

      master-prompt
        +  AGENTS.md                [writes-config]
             --- AGENTS.md
             +++ AGENTS.md
             +<!-- agemon:start:agent-rules -->
             +# AI Agent Rules
             +
             +This block is the canonical, repo-wide rule set for every AI coding agent in this
             +repository. \`CLAUDE.md\`, \`GEMINI.md\`, \`.cursorrules\`, and \`.windsurfrules\` are pointer
             +files that exist only because their tools look for those exact names — read this first.
             +
             +## Task Lifecycle
             +
             +Apply this sequence to every task:
             +
             +1. Discover existing skills, tools, utilities, and conventions before writing new code.
             +2. Plan the smallest complete change; state assumptions and tradeoffs before implementing.
             +3. Verify assumptions with tests or reproducible checks.
             +4. Implement with clear names, modular boundaries, and no dead code.
             +5. Re-verify after the change and confirm no regressions were introduced.
             +6. Record anything out of scope in \`improvements.md\` instead of fixing it inline.
             +
             +## Core Directives
             +
             +- Simplicity first: the minimum code that solves the problem, nothing speculative.
             +- Reuse existing project utilities instead of duplicating logic.
             +- Match the surrounding code's style, naming, and structure.
             +- Keep every change surgical: touch only what the task requires.
             +- Zero waste in your own changes: no unused imports, variables, or dead branches.
             +- Self-documenting code: descriptive names and named constants over explanatory comments.
             +- Preserve user-authored content outside agemon-managed files and blocks.
             +- Prefer safe, reversible changes; call out irreversible or outward-facing steps first.
             +- Security and performance by default within scope: validate input, least privilege,
             +  no needless recomputation.
             +
             +## Output Conventions
             +
             +- Reference real, existing file paths.
             +- Mark the file path above each changed code block.
             +- End every task with a short summary of what changed and why.
             +<!-- agemon:end:agent-rules -->
        +  CLAUDE.md                [writes-config]
             --- CLAUDE.md
             +++ CLAUDE.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Claude Code looks for \`CLAUDE.md\` specifically; it intentionally does not restate the rules.
        +  GEMINI.md                [writes-config]
             --- GEMINI.md
             +++ GEMINI.md
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Gemini CLI looks for \`GEMINI.md\` specifically; it intentionally does not restate the rules.
        +  .cursorrules             [writes-config]
             --- .cursorrules
             +++ .cursorrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Cursor looks for \`.cursorrules\` specifically; it intentionally does not restate the rules.
        +  .windsurfrules           [writes-config]
             --- .windsurfrules
             +++ .windsurfrules
             +<!-- AI agent rules pointer -->
             +# AI Agent Rules
             +
             +The canonical rules for this repo live in AGENTS.md — read that file in full before
             +making any changes here. This file exists only because Windsurf looks for \`.windsurfrules\` specifically; it intentionally does not restate the rules.

      Summary
        3 install · 1 register · 5 create

      Plan written to .agemon/plans/<PLAN_ID>.json"
    `);
  });

  it("inspect --json emits the redacted JSON report", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["inspect", "--json"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      {
        "isolation": {
          "status": "ignored",
          "trackedAgemonPaths": []
        },
        "resources": [
          {
            "resourceId": "rule-file:AGENTS.md",
            "path": "AGENTS.md",
            "kind": "rule-file",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "rule-file:CLAUDE.md",
            "path": "CLAUDE.md",
            "kind": "rule-file",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "rule-file:GEMINI.md",
            "path": "GEMINI.md",
            "kind": "rule-file",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "rule-file:.cursorrules",
            "path": ".cursorrules",
            "kind": "rule-file",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "rule-file:.windsurfrules",
            "path": ".windsurfrules",
            "kind": "rule-file",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "structured-config:.mcp.json",
            "path": ".mcp.json",
            "kind": "structured-config",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "structured-config:.claude/settings.json",
            "path": ".claude/settings.json",
            "kind": "structured-config",
            "state": "absent",
            "detail": null
          },
          {
            "resourceId": "structured-config:.gemini/settings.json",
            "path": ".gemini/settings.json",
            "kind": "structured-config",
            "state": "absent",
            "detail": null
          }
        ],
        "capabilities": [
          {
            "capabilityId": "cli-tool",
            "resourceId": "package:agnix",
            "label": "agnix",
            "state": "absent",
            "detail": null
          },
          {
            "capabilityId": "crg",
            "resourceId": "package:code-review-graph",
            "label": "code-review-graph",
            "state": "absent",
            "detail": null
          },
          {
            "capabilityId": "daemon",
            "resourceId": "service-unit:agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service",
            "label": "agemon-crg-daemon-fake-subprocess-git-rev-parse-show-tople.service",
            "state": "absent",
            "detail": null
          },
          {
            "capabilityId": "skills",
            "resourceId": "skill-groups:none",
            "label": "skill groups",
            "state": "absent",
            "detail": null
          }
        ],
        "structuredConfig": [
          {
            "path": ".mcp.json",
            "status": "absent",
            "redacted": null,
            "redactedPaths": [],
            "detail": null
          },
          {
            "path": ".claude/settings.json",
            "status": "absent",
            "redacted": null,
            "redactedPaths": [],
            "detail": null
          },
          {
            "path": ".gemini/settings.json",
            "status": "absent",
            "redacted": null,
            "redactedPaths": [],
            "detail": null
          }
        ],
        "binaries": [
          {
            "name": "python3",
            "present": true
          },
          {
            "name": "pip",
            "present": true
          },
          {
            "name": "pipx",
            "present": true
          },
          {
            "name": "uv",
            "present": true
          },
          {
            "name": "code-review-graph",
            "present": true
          }
        ],
        "duplication": {
          "overlaps": []
        },
        "agents": [
          {
            "adapterId": "claude-code",
            "displayName": "Claude Code",
            "configured": false,
            "configuredResources": [
              {
                "path": "CLAUDE.md",
                "kind": "rule-file",
                "exists": false
              },
              {
                "path": ".mcp.json",
                "kind": "structured-config",
                "exists": false
              },
              {
                "path": ".claude/settings.json",
                "kind": "structured-config",
                "exists": false
              }
            ],
            "installation": {
              "level": "configured",
              "executablePath": null,
              "version": null,
              "evidence": []
            }
          },
          {
            "adapterId": "gemini-cli",
            "displayName": "Gemini CLI",
            "configured": false,
            "configuredResources": [
              {
                "path": "GEMINI.md",
                "kind": "rule-file",
                "exists": false
              },
              {
                "path": ".gemini/settings.json",
                "kind": "structured-config",
                "exists": false
              }
            ],
            "installation": {
              "level": "configured",
              "executablePath": null,
              "version": null,
              "evidence": []
            }
          },
          {
            "adapterId": "copilot",
            "displayName": "GitHub Copilot",
            "configured": false,
            "configuredResources": [],
            "installation": {
              "level": "configured",
              "executablePath": null,
              "version": null,
              "evidence": []
            }
          }
        ]
      }"
    `);
  });
});
