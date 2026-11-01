import { describe, expect, it } from "vitest";
import {
  buildConsentGates,
  type GatePrompts,
  resolveConsent,
  useSharedOperations,
} from "../../../src/core/consent.js";
import type { Plan } from "../../../src/core/plan-store.js";
import type {
  ProposedOperation,
  UntrustedGitConfig,
} from "../../../src/plugins/types.js";

const UNTRUSTED_PAIRS: UntrustedGitConfig = {
  kind: "pairs",
  pairs: [
    ".git/config: diff.x.command=/tmp/differ",
    ".git/config: alias.st=status",
  ],
  fingerprint: "a".repeat(64),
};

function crgInstall(
  untrustedGitConfig?: UntrustedGitConfig,
): ProposedOperation {
  return operation({
    id: "crg:package:code-review-graph:install-package",
    capabilityId: "crg",
    resourceId: "package:code-review-graph",
    targetPath: "code-review-graph",
    action: "install-package",
    riskClass: "executes",
    preview: { kind: "note", text: "pipx install code-review-graph" },
    ...(untrustedGitConfig === undefined ? {} : { untrustedGitConfig }),
  });
}

describe("trust-repository-git-config gate", () => {
  it("holds a carrying operation instead of its normal gate", () => {
    const gates = buildConsentGates({
      plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
      isolationStatus: "ignored",
    });

    expect(gates.map((gate) => gate.id)).toEqual([
      "trust-repository-git-config",
    ]);
  });

  it("shows the normal gate's text and every pair, previews and announces them", () => {
    const [normalGate] = buildConsentGates({
      plan: planWith([crgInstall()]),
      isolationStatus: "ignored",
    });
    const [trustGate] = buildConsentGates({
      plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
      isolationStatus: "ignored",
    });

    expect(trustGate.summary).toContain(
      normalGate.summary.replace(/ Proceed\?$/, ""),
    );
    for (const pair of (UNTRUSTED_PAIRS as { pairs: string[] }).pairs) {
      expect(trustGate.summary).toContain(pair);
      expect(trustGate.announcementWithYes).toContain(pair);
    }
    expect(trustGate.forcesDiff).toBe(true);
  });

  it("is satisfiable with --yes only when --trust-repo-git-config was given", () => {
    const gateWith = (trustRepoGitConfig: boolean) =>
      buildConsentGates({
        plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
        isolationStatus: "ignored",
        trustRepoGitConfig,
      })[0];

    expect(gateWith(false).satisfiableWithYes).toBe(false);
    expect(gateWith(true).satisfiableWithYes).toBe(true);
  });

  it("leaves a carrying use-shared operation out of the shared list", () => {
    expect(
      useSharedOperations(
        planWith([
          operation({
            action: "use-shared",
            riskClass: "inert",
            requiresConsent: false,
            untrustedGitConfig: UNTRUSTED_PAIRS,
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("under --yes without the flag, skips non-interactively as consent missing, with the flag named", async () => {
    const gates = buildConsentGates({
      plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
      isolationStatus: "ignored",
    });

    const result = await resolveConsent({
      gates,
      yes: true,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
    });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toEqual([
      {
        operation: crgInstall(UNTRUSTED_PAIRS),
        reason:
          "untrusted repository git config (approve interactively or pass --yes --trust-repo-git-config): .git/config: diff.x.command=/tmp/differ; .git/config: alias.st=status",
        consentMissing: true,
      },
    ]);
  });

  it("under --yes with the flag, approves and prints the preview and every pair", async () => {
    const gates = buildConsentGates({
      plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
      isolationStatus: "ignored",
      trustRepoGitConfig: true,
    });
    const printed: string[] = [];

    const result = await resolveConsent({
      gates,
      yes: true,
      interactive: false,
      prompts: alwaysDecline,
      log: { log: (line: string) => printed.push(line) },
    });

    expect(result.approved).toEqual([crgInstall(UNTRUSTED_PAIRS)]);
    const output = printed.join("\n");
    expect(output).toContain("pipx install code-review-graph");
    for (const pair of (UNTRUSTED_PAIRS as { pairs: string[] }).pairs) {
      expect(output).toContain(pair);
    }
  });

  it("an interactive decline is a real decline, not missing consent", async () => {
    const gates = buildConsentGates({
      plan: planWith([crgInstall(UNTRUSTED_PAIRS)]),
      isolationStatus: "ignored",
    });

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts: alwaysDecline,
      log: silentLog,
    });

    expect(result.skipped[0]).toMatchObject({
      reason:
        "declined: untrusted repository git config: .git/config: diff.x.command=/tmp/differ; .git/config: alias.st=status",
      consentMissing: false,
    });
  });
});

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
    inputs: { capabilityIds: [], skillGroups: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

function conflictOn(targetPath: string): ProposedOperation {
  return operation({
    action: "conflict",
    targetPath,
    resourceId: `rule-file:${targetPath}`,
    expectedFingerprint: "sha256:theirs",
  });
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

  it("puts a declined skill group into the install-tooling gate and names it in the summary", () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "install-package",
          targetPath: "",
          resourceId: "skill-group:essentials",
          riskClass: "executes",
        }),
        operation({
          action: "skip",
          targetPath: "",
          resourceId: "skill-group:design",
          riskClass: "inert",
          requiresConsent: true,
        }),
      ]),
    });

    expect(gates.map((gate) => gate.id)).toEqual(["install-tooling"]);
    expect(gates[0].summary).toBe(
      "Install 1 package(s) (skill-group:essentials). Uses pipx / npm, and record 1 declined skill group(s) (skill-group:design). Proceed?",
    );
  });

  it("install-tooling summary mentions skill group updates", () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "install-package",
          targetPath: "",
          resourceId: "skill-group:essentials",
          riskClass: "executes",
        }),
        operation({
          id: "skills:skill-group:commit:install-package",
          action: "install-package",
          targetPath: "",
          resourceId: "skill-group:commit",
          riskClass: "executes",
          updates: [
            {
              name: "agemon-commit",
              installedFingerprint: "a".repeat(64),
              currentFingerprint: "b".repeat(64),
            },
          ],
        }),
      ]),
    });

    expect(gates[0].summary).toBe(
      "Install 1 package(s) (skill-group:essentials). Uses pipx / npm, and update or repair 1 skill group(s) to the version bundled with this agemon (skill-group:commit updates agemon-commit). Proceed?",
    );
  });

  it("asks only about recording declines when nothing installs", () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({
          action: "skip",
          targetPath: "",
          resourceId: "skill-group:design",
          riskClass: "inert",
          requiresConsent: true,
        }),
      ]),
    });

    expect(gates[0].summary).toBe(
      "Record 1 declined skill group(s) (skill-group:design). Proceed?",
    );
  });

  it("puts use-shared operations in no gate and returns them separately", () => {
    const useShared = operation({
      action: "use-shared",
      riskClass: "inert",
      requiresConsent: false,
    });
    const plan = planWith([useShared]);

    expect(buildConsentGates({ isolationStatus: "ignored", plan })).toEqual([]);
    expect(useSharedOperations(plan)).toEqual([useShared]);
  });

  it("refuses an inert, no-consent operation of any other action", () => {
    expect(() =>
      buildConsentGates({
        isolationStatus: "ignored",
        plan: planWith([
          operation({
            action: "install-package",
            riskClass: "inert",
            requiresConsent: false,
          }),
        ]),
      }),
    ).toThrow(/only use-shared operations may be/);
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
    const conflictOperation = conflictOn("CLAUDE.md");
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
        consentMissing: true,
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
        consentMissing: false,
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

  it("routes a 'replace' conflict decision into approved with the action rewritten", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });

    const prompts: GatePrompts = {
      async gate() {
        return "approve";
      },
      async conflict() {
        return "replace";
      },
    };

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts,
      log: silentLog,
    });

    expect(result.approved).toEqual([
      { ...conflictOperation, action: "replace" },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.conflictResolutions).toEqual([
      { resourceId: conflictOperation.resourceId, decision: "replace" },
    ]);
  });

  it("records a 'keep' conflict decision without approving the operation", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });

    const prompts: GatePrompts = {
      async gate() {
        return "approve";
      },
      async conflict() {
        return "keep";
      },
    };

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts,
      log: silentLog,
    });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toEqual([
      {
        operation: conflictOperation,
        reason: expect.stringContaining("keeping your version"),
        consentMissing: false,
      },
    ]);
    expect(result.conflictResolutions).toEqual([
      { resourceId: conflictOperation.resourceId, decision: "keep" },
    ]);
  });

  it("marks gates declined for lack of a TTY as missing consent, and an interactive no as declined", async () => {
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([
        operation({ action: "create", targetPath: "AGENTS.md" }),
      ]),
    });

    const nonInteractive = await resolveConsent({
      gates,
      yes: false,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
    });
    const interactive = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts: alwaysDecline,
      log: silentLog,
    });

    expect(nonInteractive.skipped.map((skip) => skip.consentMissing)).toEqual([
      true,
    ]);
    expect(interactive.skipped.map((skip) => skip.consentMissing)).toEqual([
      false,
    ]);
  });

  it("applies a recorded 'replace' decision from agemon.toml without prompting under --yes", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });

    const result = await resolveConsent({
      gates,
      yes: true,
      interactive: false,
      prompts: {
        ...alwaysDecline,
        async conflict() {
          throw new Error("must not prompt");
        },
      },
      log: silentLog,
      conflictDecisions: { [conflictOperation.resourceId]: "replace" },
    });

    expect(result.approved).toEqual([
      { ...conflictOperation, action: "replace" },
    ]);
  });

  it("still asks on a TTY when agemon.toml records 'replace', and the answer wins", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });
    const questions: string[] = [];

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: true,
      prompts: {
        ...alwaysDecline,
        async conflict(summary) {
          questions.push(summary);
          return "keep";
        },
      },
      log: silentLog,
      conflictDecisions: { [conflictOperation.resourceId]: "replace" },
    });

    expect(questions).toEqual([
      expect.stringContaining("agemon.toml records 'replace'"),
    ]);
    expect(result.approved).toEqual([]);
    expect(result.conflictResolutions).toEqual([
      { resourceId: conflictOperation.resourceId, decision: "keep" },
    ]);
  });

  it("skips a recorded 'replace' as missing consent with no TTY and no --yes", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
      conflictDecisions: { [conflictOperation.resourceId]: "replace" },
    });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toEqual([
      {
        operation: conflictOperation,
        reason: "recorded 'replace' needs --yes or an interactive session",
        consentMissing: true,
      },
    ]);
  });

  it("settles a recorded 'keep' without consent", async () => {
    const conflictOperation = conflictOn("CLAUDE.md");
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([conflictOperation]),
    });

    const result = await resolveConsent({
      gates,
      yes: false,
      interactive: false,
      prompts: alwaysDecline,
      log: silentLog,
      conflictDecisions: { [conflictOperation.resourceId]: "keep" },
    });

    expect(result.skipped.map((skip) => skip.consentMissing)).toEqual([false]);
  });

  it("keeps a conflict on a file that is not a regular file without offering 'replace'", async () => {
    const symlinkConflict = operation({
      action: "conflict",
      targetPath: "CLAUDE.md",
      resourceId: "rule-file:CLAUDE.md",
      expectedFingerprint: null,
    });
    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: planWith([symlinkConflict]),
    });

    const result = await resolveConsent({
      gates,
      yes: true,
      interactive: true,
      prompts: {
        ...alwaysDecline,
        async conflict() {
          throw new Error("must not prompt");
        },
      },
      log: silentLog,
      conflictDecisions: { [symlinkConflict.resourceId]: "replace" },
    });

    expect(result.approved).toEqual([]);
    expect(result.skipped).toEqual([
      {
        operation: symlinkConflict,
        reason: "CLAUDE.md is not a regular file; agemon leaves it alone",
        consentMissing: false,
      },
    ]);
    expect(result.conflictResolutions).toEqual([]);
  });
});

describe("agent conflicts that resolve to replace", () => {
  const agentConflict = operation({
    action: "conflict",
    capabilityId: "agents",
    resourceId: "agent-file:geo-audit-schema",
    targetPath: ".claude/agents/geo-audit-schema.md",
    expectedFingerprint: "sha256:theirs",
    preview: {
      kind: "diff",
      text: [
        "--- .claude/agents/geo-audit-schema.md",
        "+++ .claude/agents/geo-audit-schema.md",
        "-mine",
        "+---",
        "+name: geo-audit-schema",
        "+tools: Read, WebFetch",
        "+---",
      ].join("\n"),
    },
  });

  function collectingLog(): { lines: string[]; log: (line: string) => void } {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  }

  it("a recorded replace for an agent conflict under --yes prints the subagent tools line", async () => {
    const output = collectingLog();

    const result = await resolveConsent({
      gates: buildConsentGates({
        isolationStatus: "ignored",
        plan: planWith([agentConflict]),
      }),
      yes: true,
      interactive: false,
      prompts: alwaysDecline,
      log: output,
      conflictDecisions: { [agentConflict.resourceId]: "replace" },
    });

    expect(result.approved).toEqual([{ ...agentConflict, action: "replace" }]);
    expect(output.lines).toContain(
      "Installing 1 Claude Code subagent definition(s) into .claude/agents: geo-audit-schema [tools: Read, WebFetch]. Each agent can use only the tools listed.",
    );
  });

  it("an interactive replace of an agent conflict prints the tools line", async () => {
    const output = collectingLog();

    await resolveConsent({
      gates: buildConsentGates({
        isolationStatus: "ignored",
        plan: planWith([agentConflict]),
      }),
      yes: false,
      interactive: true,
      prompts: {
        ...alwaysDecline,
        async conflict() {
          return "replace";
        },
      },
      log: output,
    });

    expect(output.lines).toContainEqual(
      expect.stringContaining("geo-audit-schema [tools: Read, WebFetch]"),
    );
  });

  it("a recorded replace for a rule-file conflict prints no subagent line", async () => {
    const ruleConflict = conflictOn("CLAUDE.md");
    const output = collectingLog();

    await resolveConsent({
      gates: buildConsentGates({
        isolationStatus: "ignored",
        plan: planWith([ruleConflict]),
      }),
      yes: true,
      interactive: false,
      prompts: alwaysDecline,
      log: output,
      conflictDecisions: { [ruleConflict.resourceId]: "replace" },
    });

    expect(output.lines.join("\n")).not.toContain("subagent");
  });
});
