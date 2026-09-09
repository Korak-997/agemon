import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const createdTempDirectories: string[] = [];
const repoRoot = process.cwd();
const fixturesRoot = join(repoRoot, "test/fixtures");
const cliEntry = join(repoRoot, "src/cli/index.ts");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function normalize(output: string, repoDirectory: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return output
    .replaceAll(repoDirectory, "<REPO>")
    .replace(ansiPattern, "")
    .replace(/\bPlan [0-9a-f]{12,}\b/g, "Plan <PLAN_ID>")
    .replace(/plans\/[0-9a-f]{12,}\.json/g, "plans/<PLAN_ID>.json")
    .replace(/\bagemon \d+\.\d+\.\d+/g, "agemon <VERSION>")
    .replace(/ present \([^)]*\)/g, " present (<PATH>)")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<TIMESTAMP>")
    .replace(/ \d+\.\d+s\b/g, " <ELAPSED>")
    .trimEnd();
}

async function captureNonInteractiveRun(
  fixtureName: string,
  argv: string[],
): Promise<string> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-noninteractive-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  const repoDirectory = join(sandboxDirectory, "repo");
  const homeDirectory = join(sandboxDirectory, "home");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, { recursive: true });

  const fixtureOsReleasePath = join(repoDirectory, ".sandbox", "os-release");
  await mkdir(join(repoDirectory, ".sandbox"), { recursive: true });
  await writeFile(fixtureOsReleasePath, "ID=ubuntu\n", "utf8");

  const result = spawnSync(tsxBin, [cliEntry, ...argv], {
    cwd: repoDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDirectory,
      AGEMON_DEV: "1",
      AGEMON_FAKE_SUBPROCESS: "1",
      AGEMON_FAKE_SERVICES: "1",
      AGEMON_OS_RELEASE_PATH: fixtureOsReleasePath,
      NO_COLOR: "1",
    },
  });

  const merged = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return `exit ${result.status}\n${normalize(merged, repoDirectory)}`;
}

describe("non-interactive output contract", () => {
  it("first non-interactive run previews a plan and stops", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", []),
    ).toMatchInlineSnapshot(`
      "exit 0
      Binary check: python3 present (<PATH>)
      Binary check: pip present (<PATH>)
      Binary check: pipx present (<PATH>)
      Binary check: uv present (<PATH>)
      Binary check: code-review-graph present (<PATH>)
      Plan <PLAN_ID>   ·   agemon <VERSION>
      ────────────────────────────────────────────────────────────────────────────────

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

      ────────────────────────────────────────────────────────────────────────────────
      3 install · 1 register · 5 create

      Plan written to .agemon/plans/<PLAN_ID>.json
      Review, then re-run interactively or with --yes, or 'agemon apply --plan 82bae85277df078e'."
    `);
  });

  it("--dry-run narrates the plan without applying", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["--dry-run"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      Binary check: python3 present (<PATH>)
      Binary check: pip present (<PATH>)
      Binary check: pipx present (<PATH>)
      Binary check: uv present (<PATH>)
      Binary check: code-review-graph present (<PATH>)
      Plan <PLAN_ID>   ·   agemon <VERSION>
      ────────────────────────────────────────────────────────────────────────────────

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

      ────────────────────────────────────────────────────────────────────────────────
      3 install · 1 register · 5 create

      Plan written to .agemon/plans/<PLAN_ID>.json
      Review, then re-run interactively or with --yes, or 'agemon apply --plan 82bae85277df078e'."
    `);
  });

  it("--yes applies the plan end to end", async () => {
    expect(
      await captureNonInteractiveRun("clean-repo", ["--yes"]),
    ).toMatchInlineSnapshot(`
      "exit 0
      Binary check: python3 present (<PATH>)
      Binary check: pip present (<PATH>)
      Binary check: pipx present (<PATH>)
      Binary check: uv present (<PATH>)
      Binary check: code-review-graph present (<PATH>)
      Wrote agemon.toml — commit it so teammates and CI reconcile the same way.
      ╭ [ok] Applied 9 operations · environment verified ──────────────────────╮
      │                                                                        │
      │     crg              1 operation                                       │
      │     daemon           1 operation                                       │
      │     skills           1 operation                                       │
      │     cli-tool         1 operation                                       │
      │     master-prompt    5 operations                                      │
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
      │     crg              1 operation                                       │
      │     daemon           1 operation                                       │
      │     skills           1 operation                                       │
      │     cli-tool         1 operation                                       │
      │     master-prompt    5 operations                                      │
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
      ────────────────────────────────────────────────────────────────────────────────

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

      ────────────────────────────────────────────────────────────────────────────────
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
        }
      }"
    `);
  });
});
