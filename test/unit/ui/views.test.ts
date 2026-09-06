import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plan } from "../../../src/core/plan-store.js";
import type { InspectReport } from "../../../src/inspect/index.js";
import type { StatusReport } from "../../../src/inspect/status.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";
import {
  conflictLegend,
  gateLegend,
  renderGateIntro,
} from "../../../src/ui/consent-view.js";
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
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

describe("renderPlan", () => {
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
    duplication: [],
    trackedAgemonPaths: [],
    healthy: true,
  };

  it("renders a healthy environment with no duplication and clean isolation", () => {
    const rendered = renderStatusReport(base);
    expect(rendered).toContain("Environment healthy");
    expect(rendered).toContain("no overlapping instruction content detected");
    expect(rendered).toContain(".agemon/ is not tracked by git");
    expect(rendered).toContain("[ current ]");
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
});

describe("renderInspectReport", () => {
  const base: InspectReport = {
    isolation: { status: "ignored", trackedAgemonPaths: [] },
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
    expect(rendered).toContain("master-prompt");
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
      manualCleanup: ["crg: pipx uninstall unavailable"],
    });
    expect(rendered).toContain("Rolled back");
    expect(rendered).toContain("daemon exploded");
    expect(rendered).toContain("restored AGENTS.md");
    expect(rendered).toContain("Manual cleanup needed");
    expect(rendered).toContain("pipx uninstall unavailable");
  });
});

describe("consent-view", () => {
  it("numbers the gate, titles it and lists its operations", () => {
    const intro = renderGateIntro({
      index: 2,
      total: 3,
      gateId: "install-tooling",
      summary: "Install 1 package (code-review-graph). Proceed?",
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
    expect(intro).toContain("Install 1 package");
    expect(intro).toContain("code-review-graph");
    expect(ANSI.test(intro)).toBe(false);
  });

  it("exposes plain-text legends for gate and conflict prompts", () => {
    expect(gateLegend()).toBe("[y] proceed   [n] skip   [d] show diffs");
    expect(conflictLegend()).toBe(
      "[k] keep yours   [s] show agemon's   [x] skip",
    );
  });
});
