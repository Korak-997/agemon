import { describe, expect, it } from "vitest";
import {
  buildConsentGates,
  type GatePrompts,
  resolveConsent,
} from "../../../src/core/consent.js";
import type { Plan } from "../../../src/core/plan-store.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";

function operation(
  overrides: Partial<ProposedOperation> = {},
): ProposedOperation {
  return {
    id: "op",
    capabilityId: "cap",
    resourceId: "res",
    targetPath: "res",
    action: "create",
    riskClass: "writes-config",
    requiresConsent: true,
    expectedFingerprint: null,
    preview: { kind: "note", text: "preview body" },
    ...overrides,
  };
}

function planWith(operations: ProposedOperation[]): Plan {
  return {
    id: "plan1",
    agemonVersion: "9.9.9",
    desiredStateHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

const silentLog = { log() {} };

const alwaysDecline: GatePrompts = {
  async gate() {
    return "decline";
  },
  async conflict() {
    return "skip";
  },
};

describe("buildConsentGates", () => {
  it("orders the isolation gate first, then one gate per category present", () => {
    const gates = buildConsentGates({
      isolationStatus: "not-ignored",
      plan: planWith([
        operation({ action: "create", targetPath: "AGENTS.md" }),
        operation({
          action: "install-package",
          targetPath: "crg",
          riskClass: "executes",
        }),
        operation({
          action: "register-service",
          targetPath: "unit",
          riskClass: "executes",
        }),
        operation({ action: "conflict", targetPath: "CLAUDE.md" }),
      ]),
    });

    expect(gates.map((gate) => gate.id)).toEqual([
      "workspace-isolation",
      "install-tooling",
      "register-service",
      "touch-instruction-files",
      "resolve-conflict",
    ]);
  });

  it("omits the isolation gate when .agemon/ is already git-ignored", () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({ action: "install-package", riskClass: "executes" }),
      ]),
    });

    expect(gates.map((gate) => gate.id)).toEqual(["install-tooling"]);
  });

  it("does not gate inert operations", () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "skip",
          riskClass: "inert",
          requiresConsent: false,
        }),
      ]),
    });

    expect(gates).toEqual([]);
  });

  it("marks a credential-adjacent write-config gate as forcing its diff", () => {
    const [gate] = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "merge-key",
          targetPath: ".mcp.json",
          riskClass: "credential-adjacent",
        }),
      ]),
    });

    expect(gate.id).toBe("write-config");
    expect(gate.forcesDiff).toBe(true);
    expect(gate.satisfiableWithYes).toBe(true);
  });
});

describe("resolveConsent", () => {
  it("declines every gate with no TTY and no --yes", async () => {
    const gates = buildConsentGates({
      isolationStatus: "not-ignored",
      plan: planWith([
        operation({
          action: "install-package",
          targetPath: "crg",
          riskClass: "executes",
        }),
        operation({ action: "create", targetPath: "AGENTS.md" }),
      ]),
    });

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
    });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.workspaceIsolationApproved).toBe(false);
  });

  it("approves install/service/config gates under --yes but never a conflict", async () => {
    const conflictOperation = operation({
      action: "conflict",
      targetPath: "CLAUDE.md",
    });
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "install-package",
          targetPath: "crg",
          riskClass: "executes",
        }),
        operation({
          action: "register-service",
          targetPath: "unit",
          riskClass: "executes",
        }),
        operation({ action: "merge-key", targetPath: ".mcp.json" }),
        conflictOperation,
      ]),
    });

    const result = await resolveConsent({
      gates,
      yes: true,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
    });

    expect(result.approved.map((op) => op.action)).toEqual([
      "install-package",
      "register-service",
      "merge-key",
    ]);
    expect(result.skipped).toEqual([
      {
        operation: conflictOperation,
        reason: expect.stringContaining("non-interactive"),
      },
    ]);
  });

  it("drops only the declined gate's operations and applies the rest", async () => {
    const installOperation = operation({
      action: "install-package",
      targetPath: "crg",
      riskClass: "executes",
    });
    const ruleOperation = operation({
      action: "create",
      targetPath: "AGENTS.md",
    });
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([installOperation, ruleOperation]),
    });

    const prompts: GatePrompts = {
      async gate(summary) {
        return summary.startsWith("Install") ? "decline" : "approve";
      },
      async conflict() {
        return "skip";
      },
    };

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts,
      log: silentLog,
    });

    expect(result.approved).toEqual([ruleOperation]);
    expect(result.skipped).toEqual([
      {
        operation: installOperation,
        reason: expect.stringContaining("install-tooling"),
      },
    ]);
  });

  it("expands previews on 'd' and then honors the next reply", async () => {
    const ruleOperation = operation({
      action: "create",
      targetPath: "AGENTS.md",
    });
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([ruleOperation]),
    });

    const logged: string[] = [];
    let gateCalls = 0;
    const prompts: GatePrompts = {
      async gate() {
        gateCalls += 1;
        return gateCalls === 1 ? "show-diff" : "approve";
      },
      async conflict() {
        return "skip";
      },
    };

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts,
      log: { log: (line: string) => logged.push(line) },
    });

    expect(gateCalls).toBe(2);
    expect(logged.some((line) => line.includes("preview body"))).toBe(true);
    expect(result.approved).toEqual([ruleOperation]);
  });
});
