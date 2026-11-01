import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plan } from "../../../src/core/plan-store.js";
import type { InspectReport } from "../../../src/inspect/index.js";
import type { StatusReport } from "../../../src/inspect/status.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import type {
  ProposedOperation,
  UntrustedGitConfig,
} from "../../../src/plugins/types.js";
import { renderGateIntro } from "../../../src/ui/consent-view.js";
import { renderInspectReport } from "../../../src/ui/inspect-view.js";
import { renderPlan } from "../../../src/ui/plan-view.js";
import { renderStatusReport } from "../../../src/ui/status-view.js";
import { renderRunSummary } from "../../../src/ui/summary.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

let originalColumns: number | undefined;

beforeAll(() => {
  process.env.NO_COLOR = "1";
  originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: 80,
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(process.stdout, "columns", {
    value: originalColumns,
    configurable: true,
  });
});

function op(overrides: Partial<ProposedOperation> = {}): ProposedOperation {
  return describeOperation({
    capabilityId: "master-prompt",
    resourceId: "rule-file:AGENTS.md",
    targetPath: "AGENTS.md",
    action: "create",
    riskClass: "writes-config",
    requiresConsent: true,
    preview: { kind: "note", text: "write agemon's managed block" },
    ...overrides,
  });
}

function planWith(operations: ProposedOperation[]): Plan {
  return {
    id: "a1b2c3d4e5f6a7b8",
    agemonVersion: "2.4.0",
    desiredStateHash: "hash",
    inputs: { capabilityIds: [], skillGroups: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

describe("renderPlan", () => {
  it("lists each skill group as its own row with its skills", () => {
    const skillGroup = (id: string, lines: string[]) =>
      op({
        capabilityId: "skills",
        resourceId: `skill-group:${id}`,
        targetPath: "",
        action: "install-package",
        riskClass: "executes",
        preview: { kind: "note", text: lines.join("\n") },
      });

    const rendered = renderPlan(
      planWith([
        skillGroup("essentials", [
          "Essentials:",
          "web-design-guidelines — https://github.com/vercel-labs/agent-skills.git at 063bee9",
        ]),
        skillGroup("security", [
          "Security:",
          "agemon-security — bundled with agemon",
        ]),
      ]),
    );

    expect(rendered).toMatch(/skill-group:essentials\s+\[executes\]/u);
    expect(rendered).toMatch(/skill-group:security\s+\[executes\]/u);
    expect(rendered).toContain(
      "web-design-guidelines — https://github.com/vercel-labs/agent-skills.git at 063bee9",
    );
    expect(rendered).toContain("agemon-security — bundled with agemon");
  });

  it.each([
    [
      {
        kind: "pairs",
        pairs: [".git/config: diff.x.command=/tmp/differ"],
        fingerprint: "d".repeat(64),
      },
      "needs approval or --trust-repo-git-config: .git/config: diff.x.command=/tmp/differ",
    ],
    [
      { kind: "tooMany", count: 25, fingerprint: "d".repeat(64) },
      "skipped: too many untrusted git config keys to review (25 > 20)",
    ],
    [
      { kind: "unshowable", fingerprint: "d".repeat(64) },
      "skipped: untrusted git config contains entries that cannot be shown safely",
    ],
    [
      { kind: "unreadable", category: "cap-reached" },
      "skipped: could not read this repository's git config (cap-reached)",
    ],
  ] satisfies Array<[UntrustedGitConfig, string]> as Array<
    [UntrustedGitConfig, string]
  >)(
    "marks an operation with untrusted git config as needing approval or skipped (%#)",
    (untrustedGitConfig, line) => {
      const rendered = renderPlan(
        planWith(
          [
            op({
              capabilityId: "crg",
              resourceId: "package:code-review-graph",
              targetPath: "code-review-graph",
              action: "install-package",
              riskClass: "executes",
            }),
          ].map((operation) => ({ ...operation, untrustedGitConfig })),
        ),
      );

      expect(rendered).toContain(line);
      expect(rendered).toMatch(
        untrustedGitConfig.kind === "pairs" ? /1 install/ : /1 skip/,
      );
    },
  );

  it("reports an empty plan as nothing to do", () => {
    const rendered = renderPlan(planWith([]));
    expect(rendered).toContain("Plan a1b2c3d4e5f6a7b8");
    expect(rendered).toContain("agemon 2.4.0");
    expect(rendered).toContain("nothing to do");
    expect(ANSI.test(rendered)).toBe(false);
  });

  it("groups a mixed plan by capability and prints an action count footer", () => {
    const rendered = renderPlan(
      planWith([
        op({ action: "create", targetPath: "AGENTS.md" }),
        op({
          action: "conflict",
          targetPath: "CLAUDE.md",
          resourceId: "rule-file:CLAUDE.md",
        }),
        op({
          capabilityId: "crg",
          action: "install-package",
          targetPath: "code-review-graph",
          resourceId: "package:code-review-graph",
          riskClass: "executes",
          preview: { kind: "note", text: "pipx install code-review-graph" },
        }),
      ]),
    );

    expect(rendered).toContain("master-prompt");
    expect(rendered).toContain("crg");
    expect(rendered).toMatch(/AGENTS\.md/);
    expect(rendered).toContain("[writes-config]");
    expect(rendered).toContain("[executes]");
    expect(rendered).toContain("1 create");
    expect(rendered).toContain("1 conflict");
    expect(rendered).toContain("1 install");
    expect(ANSI.test(rendered)).toBe(false);
  });

  it("renders an all-conflict plan with a conflict glyph and note", () => {
    const rendered = renderPlan(
      planWith([
        op({
          action: "conflict",
          targetPath: "CLAUDE.md",
          resourceId: "rule-file:CLAUDE.md",
        }),
      ]),
    );
    expect(rendered).toContain("1 conflict");
    expect(rendered).toContain("write agemon's managed block");
  });
});

describe("renderStatusReport", () => {
  const base: StatusReport = {
    managedResources: [
      {
        resourceId: "rule-file:AGENTS.md",
        target: "AGENTS.md",
        ownershipMode: "delimited-block",
        health: "managed-current",
        detail: null,
      },
    ],
    capabilities: [
      {
        capabilityId: "crg",
        resourceId: "package:code-review-graph",
        label: "code-review-graph",
        state: "present-adopted",
        detail: "pre-existing install",
        health: null,
      },
    ],
    sharedResources: [],
    duplication: [],
    trackedAgemonPaths: [],
    trackingCheckError: null,
    unconfirmedLedgerEntries: 0,
    configError: null,
    interruptedApply: null,
    agentsSummary: { total: 3, configured: 1, installed: 0 },
    healthy: true,
    hasAgemonState: true,
  };

  it("renders a healthy environment with no duplication and clean isolation", () => {
    const rendered = renderStatusReport(base);
    expect(rendered).toContain("Environment healthy");
    expect(rendered).toContain("no overlapping instruction content detected");
    expect(rendered).toContain(".agemon/ is not tracked by git");
    expect(rendered).toContain("[ current ]");
    expect(rendered).toContain("1/3 configured, 0/3 installed");
    expect(ANSI.test(rendered)).toBe(false);
  });

  it("flags a drifted resource and needs-attention headline", () => {
    const rendered = renderStatusReport({
      ...base,
      healthy: false,
      managedResources: [
        {
          ...base.managedResources[0],
          health: "managed-drifted",
          detail: "agemon template updated — re-run to refresh",
        },
      ],
    });
    expect(rendered).toContain("Environment needs attention");
    expect(rendered).toContain("[ drifted ]");
    expect(rendered).toContain("agemon template updated");
  });

  it("prints control characters in a verify detail as ?", () => {
    const rendered = renderStatusReport({
      ...base,
      healthy: false,
      capabilities: [
        {
          ...base.capabilities[0],
          health: {
            ok: false,
            detail: `status failed${String.fromCharCode(27)}]0;pwned`,
            attention: null,
          },
        },
      ],
    });

    expect(rendered).toContain("status failed?]0;pwned");
    expect(rendered).not.toContain(`${String.fromCharCode(27)}]0;`);
  });

  it("prints control characters in a managed resource detail as ?", () => {
    const escapeCharacter = String.fromCharCode(27);
    const rendered = renderStatusReport({
      ...base,
      managedResources: [
        { ...base.managedResources[0], detail: `d${escapeCharacter}]0;x` },
      ],
    });

    expect(rendered).not.toContain(escapeCharacter);
    expect(rendered).toContain("d?]0;x");
  });

  it('status renders present-modified as "present · changed"', () => {
    const rendered = renderStatusReport({
      ...base,
      capabilities: [
        {
          capabilityId: "agents",
          resourceId: "agent-file:geo-audit-technical",
          label: "geo-audit-technical",
          state: "present-modified",
          detail:
            "changed since agemon wrote it; agemon keeps your version (conflict)",
          health: null,
        },
      ],
    });

    expect(rendered).toContain("present · changed");
  });
});

describe("renderStatusReport — shared tools", () => {
  const report: StatusReport = {
    managedResources: [],
    capabilities: [],
    sharedResources: [
      {
        tool: "code-review-graph",
        origin: "installed",
        recordedBy: "/home/u/a",
        holders: [
          { path: "/home/u/a", thisRepository: true, missing: false },
          { path: "/home/u/gone", thisRepository: false, missing: true },
        ],
        heldWithoutLedgerEntry: false,
        manualRemoveCommand: "pipx uninstall code-review-graph",
      },
      {
        tool: "agnix",
        origin: "migrated",
        recordedBy: "/home/u/b",
        holders: [{ path: "/home/u/a", thisRepository: true, missing: false }],
        heldWithoutLedgerEntry: true,
        manualRemoveCommand: "npm uninstall --global agnix",
      },
    ],
    duplication: [],
    trackedAgemonPaths: [],
    trackingCheckError: null,
    unconfirmedLedgerEntries: 0,
    configError: null,
    interruptedApply: null,
    agentsSummary: { total: 0, configured: 0, installed: 0 },
    healthy: true,
    hasAgemonState: true,
  };

  it("lists each shared tool with its origin, holders and missing holders", () => {
    const rendered = renderStatusReport(report);
    expect(rendered).toContain("Shared tools");
    expect(rendered).toContain("/home/u/a (this repository)");
    expect(rendered).toContain(
      "/home/u/gone (missing — dropped on the next change)",
    );
    expect(rendered).toContain("installed by /home/u/a");
  });

  it("marks a holder entry this repository's ledger lost", () => {
    expect(renderStatusReport(report)).toContain(
      "held by this repository but not in its ledger — run 'agemon' to repair",
    );
  });

  it("says when no shared tool is recorded", () => {
    expect(renderStatusReport({ ...report, sharedResources: [] })).toContain(
      "none recorded on this machine",
    );
  });
});

describe("renderInspectReport", () => {
  const base: InspectReport = {
    isolation: {
      status: "ignored",
      trackedAgemonPaths: [],
      trackingCheckError: null,
    },
    configError: null,
    resources: [
      {
        resourceId: "rule-file:AGENTS.md",
        path: "AGENTS.md",
        kind: "rule-file",
        state: "unmanaged",
        detail: null,
      },
    ],
    capabilities: [],
    structuredConfig: [],
    binaries: [{ name: "code-review-graph", present: false }],
    duplication: { overlaps: [] },
    agents: [],
  };

  it("renders an empty repo with no capability rows and no duplication", () => {
    const rendered = renderInspectReport(base);
    expect(rendered).toContain("Resources");
    expect(rendered).toContain("[ unmanaged ]");
    expect(rendered).toContain("no capability reports state in this repo");
    expect(rendered).toContain("no overlapping instruction content detected");
    expect(ANSI.test(rendered)).toBe(false);
  });

  it("renders a fully-managed repo with capability rows", () => {
    const rendered = renderInspectReport({
      ...base,
      resources: [
        {
          resourceId: "rule-file:AGENTS.md",
          path: "AGENTS.md",
          kind: "rule-file",
          state: "managed-current",
          detail: "delimited-block",
        },
      ],
      capabilities: [
        {
          capabilityId: "crg",
          resourceId: "package:code-review-graph",
          label: "code-review-graph",
          state: "present-managed",
          detail: "installed via pipx",
        },
      ],
    });
    expect(rendered).toContain("[ managed-current ]");
    expect(rendered).toContain("code-review-graph");
    expect(rendered).toContain("present · managed");
  });

  it("renders detected agents with their resolved path and version", () => {
    const rendered = renderInspectReport({
      ...base,
      agents: [
        {
          adapterId: "claude-code",
          displayName: "Claude Code",
          configured: true,
          configuredResources: [],
          installation: {
            level: "installed",
            executablePath: "/usr/local/bin/claude",
            version: "1.8.2",
            evidence: [
              "resolved claude at /usr/local/bin/claude",
              "reported version 1.8.2",
            ],
          },
        },
        {
          adapterId: "gemini-cli",
          displayName: "Gemini CLI",
          configured: false,
          configuredResources: [],
          installation: {
            level: "configured",
            executablePath: null,
            version: null,
            evidence: [],
          },
        },
      ],
    });
    expect(rendered).toContain("Agents");
    expect(rendered).toContain("Claude Code");
    expect(rendered).toContain("[ configured, installed ]");
    expect(rendered).toContain("/usr/local/bin/claude");
    expect(rendered).toContain("v1.8.2");
    expect(rendered).toContain("Gemini CLI");
    expect(rendered).toContain("[ not configured ]");
  });

  it("prints control characters in resource and capability details as ?", () => {
    const escapeCharacter = String.fromCharCode(27);
    const rendered = renderInspectReport({
      ...base,
      resources: [{ ...base.resources[0], detail: `a${escapeCharacter}]0;x` }],
      capabilities: [
        {
          capabilityId: "agents",
          resourceId: "agent-file:geo-audit-technical",
          label: "geo-audit-technical",
          state: "present-modified",
          detail: `b${escapeCharacter}]0;y`,
        },
      ],
    });

    expect(rendered).not.toContain(escapeCharacter);
    expect(rendered).toContain("a?]0;x");
    expect(rendered).toContain("b?]0;y");
  });
});

describe("renderRunSummary", () => {
  it("boxes a success with capability lines and next steps", () => {
    const rendered = renderRunSummary({
      kind: "success",
      applied: [
        op({ action: "create", targetPath: "AGENTS.md" }),
        op({
          capabilityId: "crg",
          action: "install-package",
          targetPath: "code-review-graph",
        }),
      ],
      nextSteps: [
        "commit agemon.toml so teammates and CI reconcile the same way",
      ],
    });

    expect(rendered).toContain("Applied 2 operations");
    expect(rendered).toContain("environment verified");
    expect(rendered).toContain("Instruction files");
    expect(rendered).toContain("Next steps");
    expect(rendered).toContain("commit agemon.toml");
  });

  it("boxes a decline with the skip reasons", () => {
    const rendered = renderRunSummary({
      kind: "declined",
      skipped: [
        { label: "code-review-graph", reason: "declined at the install gate" },
      ],
    });
    expect(rendered).toContain("Nothing applied");
    expect(rendered).toContain("code-review-graph");
    expect(rendered).toContain("declined at the install gate");
  });

  it("boxes a rollback failure with restored, reverted and manual-cleanup lists", () => {
    const rendered = renderRunSummary({
      kind: "failure",
      message: "daemon exploded",
      restored: ["restored AGENTS.md"],
      reverted: ["crg"],
      kept: [],
      manualCleanup: ["crg: pipx uninstall unavailable"],
    });
    expect(rendered).toContain("Rolled back");
    expect(rendered).toContain("daemon exploded");
    expect(rendered).toContain("restored AGENTS.md");
    expect(rendered).toContain("Manual cleanup needed");
    expect(rendered).toContain("pipx uninstall unavailable");
    expect(rendered).not.toContain("Kept");
  });

  it("lists what a rollback kept, and says so in the title", () => {
    const rendered = renderRunSummary({
      kind: "failure",
      message: "breaker exploded",
      restored: [],
      reverted: [],
      kept: ["Kept updated skill agemon-commit (agemon's newer version)"],
      manualCleanup: [],
    });

    expect(rendered).toContain(
      "Rolled back — except the changes listed under Kept",
    );
    expect(rendered).toContain(
      "Kept updated skill agemon-commit (agemon's newer version)",
    );
  });

  it("prints control characters as ? in every kind's untrusted text", () => {
    const hostile = `x${String.fromCharCode(27)}]0;pwned${String.fromCharCode(7)}`;
    const summaries = [
      renderRunSummary({
        kind: "success",
        applied: [op()],
        nextSteps: [hostile],
      }),
      renderRunSummary({
        kind: "declined",
        skipped: [{ label: hostile, reason: hostile }],
      }),
      renderRunSummary({
        kind: "partial",
        appliedCount: 1,
        problems: [hostile],
      }),
      renderRunSummary({
        kind: "failure",
        message: hostile,
        restored: [hostile],
        reverted: [hostile],
        kept: [hostile],
        manualCleanup: [hostile],
      }),
    ];

    for (const rendered of summaries) {
      expect(rendered).toContain("x?]0;pwned?");
      expect(rendered).not.toContain(String.fromCharCode(7));
      expect(rendered).not.toContain(`${String.fromCharCode(27)}]0;`);
    }
  });
});

describe("consent-view", () => {
  it("numbers the gate, titles it and lists its operations", () => {
    const intro = renderGateIntro({
      index: 2,
      total: 3,
      gateId: "install-tooling",
      operations: [
        op({
          capabilityId: "crg",
          action: "install-package",
          targetPath: "code-review-graph",
        }),
      ],
    });

    expect(intro).toContain("Gate 2 / 3");
    expect(intro).toContain("Install tooling");
    expect(intro).toContain("code-review-graph");
    expect(intro).not.toContain("─");
    expect(ANSI.test(intro)).toBe(false);
  });
});
