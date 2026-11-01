import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveJournalDirectory,
  writeJournal,
} from "../../../src/core/apply-journal.js";
import type {
  ApprovedOperationSet,
  ConsentGate,
} from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import {
  buildPlan,
  exitCodeForOutcome,
  reconcile,
  uninstallPlugins,
} from "../../../src/core/orchestrator.js";
import {
  type Plan,
  readPlan,
  resolveDesiredStateHash,
  writePlan,
} from "../../../src/core/plan-store.js";
import { recoverInterruptedApply } from "../../../src/core/recover.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import type {
  AgemonPlugin,
  UntrustedGitConfig,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function createNoOpServiceManager(): ServiceManager {
  return {
    kind: "systemd-user",
    async isActive() {
      return { active: false, failed: false };
    },
    async isSandboxEnforced() {
      return false;
    },
    async registerAutostart() {
      return {
        unitPath: "",
        attemptLabel: "strict",
        failedAttempts: [],
      };
    },
    async unregisterAutostart() {},
    async readUnitWorkingDirectory() {
      return null;
    },
    async readUnitEnvironment() {
      return null;
    },
    unitPathFor: (unitName) => `/fake/systemd/user/${unitName}`,
    async isLingerEnabled() {
      return false;
    },
    async enableLinger() {},
    async disableLinger() {},
    async findAgemonDaemonUnit() {
      return null;
    },
  };
}

function approveEveryGate(gates: ConsentGate[]): Promise<ApprovedOperationSet> {
  const approved = gates.flatMap((gate) =>
    gate.id === "resolve-conflict" ? [] : gate.operations,
  );
  return Promise.resolve({
    approved,
    skipped: [],
    workspaceIsolationApproved: true,
    conflictResolutions: [],
  });
}

async function createTestContext(
  consent: Context["consent"],
): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-orchestrator-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  await writeFile(join(sandboxDirectory, ".gitignore"), "/.agemon/\n", "utf8");

  return {
    cwd: sandboxDirectory,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    log: console,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    confirm: async () => false,
    consent,
  };
}

interface FakeCapabilityOptions {
  id: string;
  targetPath: string;
  failsVerificationAfterApply?: boolean;
}

function createFakeCapability(options: FakeCapabilityOptions): {
  plugin: AgemonPlugin;
  planCallCount: () => number;
  installCallCount: () => number;
} {
  let planCalls = 0;
  let installCalls = 0;
  let verifyCalls = 0;
  return {
    planCallCount: () => planCalls,
    installCallCount: () => installCalls,
    plugin: {
      id: options.id,
      riskClass: "writes-config",
      async detect() {
        return { present: false, preExisting: false };
      },
      async plan() {
        planCalls += 1;
        return [
          describeOperation({
            capabilityId: options.id,
            resourceId: `file:${options.targetPath}`,
            targetPath: options.targetPath,
            action: "create",
            riskClass: "writes-config",
            requiresConsent: true,
            preview: { kind: "note", text: `create ${options.targetPath}` },
          }),
        ];
      },
      async materialize() {
        return [];
      },
      async install(ctx) {
        installCalls += 1;
        await writeFile(
          join(ctx.cwd, options.targetPath),
          `written by ${options.id}\n`,
          "utf8",
        );
      },
      async verify() {
        verifyCalls += 1;
        return options.failsVerificationAfterApply && verifyCalls > 1
          ? { ok: false, detail: "verification failed on purpose" }
          : { ok: true };
      },
      async uninstall() {
        return;
      },
    },
  };
}

function createSkippingCapability(packageNames: string[]): AgemonPlugin {
  return {
    id: "alpha",
    riskClass: "executes",
    async detect() {
      return { present: false, preExisting: false };
    },
    async plan() {
      return packageNames.map((name) =>
        describeOperation({
          capabilityId: "alpha",
          resourceId: `package:${name}`,
          targetPath: name,
          action: "install-package",
          riskClass: "executes",
          requiresConsent: true,
          preview: { kind: "note", text: `install ${name}` },
        }),
      );
    },
    async apply(_ctx, operations) {
      return {
        skipped: operations.map((operation) => ({
          operationId: operation.id,
          reason: `${operation.targetPath} refused on purpose`,
        })),
      };
    },
    async verify() {
      return { ok: true };
    },
    async uninstall() {},
  };
}

const RECONCILE_OPTIONS = {
  agemonVersion: "9.9.9",
  allowUnignoredState: false,
} as const;

describe("reconcile", () => {
  it("applies approved operations and persists the plan under .agemon/plans", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await reconcile(context, [plugin], RECONCILE_OPTIONS);

    expect(installCallCount()).toBe(1);
    await expect(
      readFile(join(context.cwd, "alpha.txt"), "utf8"),
    ).resolves.toBe("written by alpha\n");
    const planFiles = await readdir(join(context.cwd, ".agemon/plans"));
    expect(planFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("an apply where every approved operation is skipped ends as nothing-to-do", async () => {
    const infoLines: string[] = [];
    const successLines: string[] = [];
    const context = await createTestContext(approveEveryGate);
    context.ui = {
      ...context.ui,
      info: (line) => infoLines.push(line),
      succeed: (line) => {
        successLines.push(line ?? "");
      },
    };

    const outcome = await reconcile(
      context,
      [createSkippingCapability(["alpha"])],
      RECONCILE_OPTIONS,
    );

    expect(outcome).toBe("nothing-to-do");
    expect(infoLines).toContain(
      "Skipped install-package alpha — alpha refused on purpose",
    );
    expect(successLines).toContain(
      "Nothing was applied; see the skipped items above.",
    );
  });

  it("an apply where every approved operation is skipped and another gate had no consent ends in drift", async () => {
    const context = await createTestContext(async (gates) => {
      const [approvedOperation, missingConsentOperation] = gates.flatMap(
        (gate) => gate.operations,
      );
      return {
        approved: [approvedOperation],
        skipped: [
          {
            operation: missingConsentOperation,
            reason: "no consent for the 'install-tooling' gate",
            consentMissing: true,
          },
        ],
        workspaceIsolationApproved: true,
        conflictResolutions: [],
      };
    });

    const outcome = await reconcile(
      context,
      [createSkippingCapability(["alpha", "beta"])],
      RECONCILE_OPTIONS,
    );

    expect(outcome).toBe("drift");
  });

  it("makes no changes when consent declines every operation", async () => {
    const context = await createTestContext(async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: false,
      conflictResolutions: [],
    }));
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await reconcile(context, [plugin], RECONCILE_OPTIONS);

    expect(installCallCount()).toBe(0);
    await expect(
      readFile(join(context.cwd, "alpha.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("only runs the capabilities named by --only", async () => {
    const context = await createTestContext(approveEveryGate);
    const alpha = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });
    const beta = createFakeCapability({ id: "beta", targetPath: "beta.txt" });

    await reconcile(context, [alpha.plugin, beta.plugin], {
      ...RECONCILE_OPTIONS,
      only: ["alpha"],
    });

    expect(alpha.installCallCount()).toBe(1);
    expect(beta.installCallCount()).toBe(0);
  });

  it("writes agemon.toml on first apply, then is a silent no-op that adds no ledger entries", async () => {
    const context = await createTestContext(approveEveryGate);
    const succeeded: string[] = [];
    context.ui = {
      ...context.ui,
      succeed: (message: string) => succeeded.push(message),
    };

    await reconcile(context, [masterPromptPlugin], {
      ...RECONCILE_OPTIONS,
      only: ["master-prompt"],
      persistConfig: true,
    });

    const configContents = await readFile(
      join(context.cwd, "agemon.toml"),
      "utf8",
    );
    expect(configContents).toContain("master-prompt");
    const ledgerEntriesAfterFirstRun = context.manifest.getActions().length;
    expect(ledgerEntriesAfterFirstRun).toBeGreaterThan(0);

    await reconcile(context, [masterPromptPlugin], {
      ...RECONCILE_OPTIONS,
      only: ["master-prompt"],
      persistConfig: false,
    });

    expect(context.manifest.getActions()).toHaveLength(
      ledgerEntriesAfterFirstRun,
    );
    expect(succeeded.some((message) => message.includes("Nothing to do"))).toBe(
      true,
    );
  });

  it("stops after writing a reviewable plan when a first non-interactive run cannot consent", async () => {
    const context = await createTestContext(() => {
      throw new Error("consent must not be reached");
    });
    context.yes = false;
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await reconcile(context, [plugin], {
      ...RECONCILE_OPTIONS,
      persistConfig: true,
    });

    expect(installCallCount()).toBe(0);
    const planFiles = await readdir(join(context.cwd, ".agemon/plans"));
    expect(planFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await expect(
      readFile(join(context.cwd, "agemon.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(context.cwd, "alpha.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops after the preview under --dry-run even when the session could consent", async () => {
    const context = await createTestContext(() => {
      throw new Error("consent must not be reached");
    });
    context.dryRun = true;
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await reconcile(context, [plugin], RECONCILE_OPTIONS);

    expect(installCallCount()).toBe(0);
    const planFiles = await readdir(join(context.cwd, ".agemon/plans"));
    expect(planFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("applies non-interactively when agemon.toml intent is already present", async () => {
    const context = await createTestContext(approveEveryGate);
    context.yes = false;
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await reconcile(context, [plugin], {
      ...RECONCILE_OPTIONS,
      persistConfig: false,
    });

    expect(installCallCount()).toBe(1);
  });

  it("applies the rebuilt plan when a stored plan still matches", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin, planCallCount, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });
    const stored = await buildPlan(context, [plugin], {
      agemonVersion: "9.9.9",
    });

    await reconcile(context, [plugin], {
      ...RECONCILE_OPTIONS,
      plan: stored,
    });

    expect(planCallCount()).toBe(2);
    expect(installCallCount()).toBe(1);
    await expect(
      readFile(join(context.cwd, `.agemon/plans/${stored.id}.json`), "utf8"),
    ).resolves.toContain(stored.id);
  });

  describe("refuses a stored plan that does not rebuild to the same content", () => {
    async function expectRebuildMismatch(
      tamper: (stored: Plan) => Plan,
      message: RegExp,
      selectedPlugins?: (plugin: AgemonPlugin) => AgemonPlugin[],
    ): Promise<void> {
      let consentAsked = false;
      const context = await createTestContext((gates) => {
        consentAsked = true;
        return approveEveryGate(gates);
      });
      const { plugin, installCallCount } = createFakeCapability({
        id: "alpha",
        targetPath: "alpha.txt",
      });
      const stored = await buildPlan(context, [plugin], {
        agemonVersion: "9.9.9",
      });

      await expect(
        reconcile(context, selectedPlugins?.(plugin) ?? [plugin], {
          ...RECONCILE_OPTIONS,
          plan: tamper(stored),
        }),
      ).rejects.toThrow(message);

      expect(consentAsked).toBe(false);
      expect(installCallCount()).toBe(0);
    }

    const editedOperation = (
      stored: Plan,
      edit: Partial<Plan["operations"][number]>,
    ): Plan => ({
      ...stored,
      operations: stored.operations.map((operation) => ({
        ...operation,
        ...edit,
      })),
    });

    it.each([
      [
        "an edited preview",
        (stored: Plan) =>
          editedOperation(stored, {
            preview: { kind: "note", text: "harmless" },
          }),
      ],
      [
        "a relabelled risk class",
        (stored: Plan) => editedOperation(stored, { riskClass: "inert" }),
      ],
      [
        "an added operation",
        (stored: Plan) => ({
          ...stored,
          operations: [
            ...stored.operations,
            describeOperation({
              capabilityId: "alpha",
              resourceId: "file:extra.txt",
              targetPath: "extra.txt",
              action: "create",
              riskClass: "writes-config",
              requiresConsent: true,
              preview: { kind: "note", text: "create extra.txt" },
            }),
          ],
        }),
      ],
      [
        "an injected decline",
        (stored: Plan) => ({
          ...stored,
          operations: [
            ...stored.operations,
            describeOperation({
              capabilityId: "alpha",
              resourceId: "skill-group:security",
              targetPath: "",
              action: "skip",
              riskClass: "inert",
              requiresConsent: true,
              preview: { kind: "note", text: "declined" },
            }),
          ],
        }),
      ],
    ])("%s under the original id", async (_label, tamper) => {
      await expectRebuildMismatch(
        tamper,
        /no longer matches what agemon would do now: the repository changed since it was made, or the plan file was edited\. Run 'agemon plan' again/,
      );
    });

    it("says the repository's git config changed when only that differs", async () => {
      await expectRebuildMismatch(
        (stored) =>
          editedOperation(stored, {
            untrustedGitConfig: {
              kind: "unshowable",
              fingerprint: "a".repeat(64),
            },
          }),
        /this repository's git config changed since the plan\./,
      );
    });

    it("names the skill groups the plan was made with", async () => {
      await expectRebuildMismatch((stored) => {
        const inputs = { ...stored.inputs, skillGroups: "security" };
        return {
          ...stored,
          inputs,
          desiredStateHash: resolveDesiredStateHash(inputs),
        };
      }, /was made with "security" skill groups; this run has the default\./);
    });

    it("names the capabilities the plan was made for", async () => {
      await expectRebuildMismatch(
        (stored) => stored,
        /was made for capabilities \[alpha\]; this run selects \[alpha, beta\] \(from --only, --skip-daemon or agemon\.toml\)\./,
        (plugin) => [
          plugin,
          createFakeCapability({ id: "beta", targetPath: "beta.txt" }).plugin,
        ],
      );
    });
  });

  describe("with a supplied plan", () => {
    function suppliedPlan(overrides: Partial<Plan> = {}): Plan {
      return {
        id: "0123456789abcdef",
        agemonVersion: "9.9.9",
        desiredStateHash: "hash",
        inputs: { capabilityIds: [], skillGroups: null },
        createdAt: "2026-01-01T00:00:00.000Z",
        operations: [
          describeOperation({
            capabilityId: "alpha",
            resourceId: "file:alpha.txt",
            targetPath: "alpha.txt",
            action: "create",
            riskClass: "writes-config",
            requiresConsent: true,
            preview: { kind: "note", text: "create alpha.txt" },
          }),
        ],
        ...overrides,
      };
    }

    async function expectRefusedBeforeAnyWrite(
      plan: Plan,
      plugins: AgemonPlugin[],
      message: RegExp,
    ): Promise<void> {
      let consentAsked = false;
      const context = await createTestContext((gates) => {
        consentAsked = true;
        return approveEveryGate(gates);
      });

      await expect(
        reconcile(context, plugins, { ...RECONCILE_OPTIONS, plan }),
      ).rejects.toThrow(message);

      expect(consentAsked).toBe(false);
      await expect(readdir(context.cwd)).resolves.toEqual([".gitignore"]);
    }

    it("applies a stored plan whose preview carries CRLF from the user's AGENTS.md", async () => {
      const context = await createTestContext(approveEveryGate);
      await writeFile(
        join(context.cwd, "AGENTS.md"),
        "# Our rules\r\n- be kind\r\n",
        "utf8",
      );
      const built = await buildPlan(context, [masterPromptPlugin], {
        agemonVersion: "9.9.9",
      });
      await writePlan(context.cwd, built);

      await reconcile(context, [masterPromptPlugin], {
        ...RECONCILE_OPTIONS,
        plan: await readPlan(context.cwd, built.id),
      });

      await expect(
        readFile(join(context.cwd, "AGENTS.md"), "utf8"),
      ).resolves.toContain("<!-- agemon:start:agent-rules -->");
    });

    it("refuses a plan made by another agemon version", async () => {
      const { plugin } = createFakeCapability({
        id: "alpha",
        targetPath: "alpha.txt",
      });

      await expectRefusedBeforeAnyWrite(
        suppliedPlan({ agemonVersion: "1.0.0" }),
        [plugin],
        /Plan 0123456789abcdef was made by agemon 1\.0\.0; this is agemon 9\.9\.9\. Re-run 'agemon plan'\./,
      );
    });

    it("refuses a plan that references an unknown capability", async () => {
      const { plugin } = createFakeCapability({
        id: "beta",
        targetPath: "beta.txt",
      });

      await expectRefusedBeforeAnyWrite(
        suppliedPlan(),
        [plugin],
        /Plan 0123456789abcdef references unknown capabilities: alpha\./,
      );
    });

    it("refuses a file action for a capability that never writes files", async () => {
      const { plugin } = createFakeCapability({
        id: "alpha",
        targetPath: "alpha.txt",
      });
      const { materialize: _unused, ...packageOnlyPlugin } = plugin;

      await expectRefusedBeforeAnyWrite(
        suppliedPlan(),
        [packageOnlyPlugin],
        /Plan 0123456789abcdef asks alpha to create alpha\.txt, which it never does\./,
      );
    });
  });
});

describe("an interrupted apply blocks reconcile and nuke", () => {
  const journal = {
    planId: "0123456789abcdef",
    startedAt: "2026-10-24T00:00:00.000Z",
    capabilityOrder: ["fake"],
    ledgerBefore: [],
    snapshots: [],
  };

  it.each(["reconcile", "uninstallPlugins"] as const)(
    "%s refuses to start and points to 'agemon recover'",
    async (entryPoint) => {
      const ctx = await createTestContext(approveEveryGate);
      ctx.dryRun = true;
      const fake = createFakeCapability({ id: "fake", targetPath: "x.md" });
      await writeJournal(ctx.cwd, journal);

      const run =
        entryPoint === "reconcile"
          ? reconcile(ctx, [fake.plugin], {
              agemonVersion: "9.9.9",
              allowUnignoredState: false,
            })
          : uninstallPlugins(ctx, [fake.plugin], {});

      await expect(run).rejects.toThrow(
        "An earlier apply (plan 0123456789abcdef, started 2026-10-24T00:00:00.000Z) was interrupted. Run 'agemon recover' to restore the files it changed.",
      );
      expect(fake.planCallCount()).toBe(0);
    },
  );

  it("names the path of an invalid journal", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const directory = await resolveJournalDirectory(ctx.cwd);
    await mkdir(directory, { recursive: true });
    const journalPath = join(directory, "0123456789abcdef.json");
    await writeFile(journalPath, "not json", "utf8");

    await expect(
      reconcile(ctx, [], {
        agemonVersion: "9.9.9",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(
      `The interrupted-apply journal ${journalPath} is invalid:`,
    );
  });
});

describe("reconcile outcomes", () => {
  function skipEveryOperation(consentMissing: boolean): Context["consent"] {
    return async (gates) => ({
      approved: [],
      skipped: gates.flatMap((gate) =>
        gate.operations.map((operation) => ({
          operation,
          reason: "test",
          consentMissing,
        })),
      ),
      workspaceIsolationApproved: true,
      conflictResolutions: [],
    });
  }

  it("maps each outcome to its exit code", () => {
    expect(
      (
        [
          "applied",
          "nothing-to-do",
          "previewed",
          "declined",
          "drift",
          "partial",
        ] as const
      ).map(exitCodeForOutcome),
    ).toEqual([0, 0, 0, 0, 2, 2]);
  });

  it("returns 'applied' after a verified apply", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await expect(reconcile(context, [plugin], RECONCILE_OPTIONS)).resolves.toBe(
      "applied",
    );
  });

  it("returns 'partial' when verification fails after the apply", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
      failsVerificationAfterApply: true,
    });

    await expect(reconcile(context, [plugin], RECONCILE_OPTIONS)).resolves.toBe(
      "partial",
    );
  });

  it("returns 'previewed' under --dry-run", async () => {
    const context = await createTestContext(approveEveryGate);
    context.dryRun = true;
    const { plugin } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await expect(reconcile(context, [plugin], RECONCILE_OPTIONS)).resolves.toBe(
      "previewed",
    );
  });

  it("returns 'declined' when the user said no", async () => {
    const context = await createTestContext(skipEveryOperation(false));
    const { plugin } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await expect(reconcile(context, [plugin], RECONCILE_OPTIONS)).resolves.toBe(
      "declined",
    );
  });

  it("returns 'drift' when operations are pending but nobody could consent", async () => {
    const context = await createTestContext(skipEveryOperation(true));
    const { plugin, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await expect(reconcile(context, [plugin], RECONCILE_OPTIONS)).resolves.toBe(
      "drift",
    );
    expect(installCallCount()).toBe(0);
  });

  function createGitConfigCapability(untrustedGitConfig: UntrustedGitConfig): {
    plugin: AgemonPlugin;
    applied: string[];
  } {
    const appliedByGitty: string[] = [];
    const gitty: AgemonPlugin = {
      id: "gitty",
      async detect() {
        return { present: false, preExisting: false };
      },
      async plan() {
        return [
          {
            ...describeOperation({
              capabilityId: "gitty",
              resourceId: "package:gitty",
              targetPath: "gitty",
              action: "install-package",
              riskClass: "executes",
              requiresConsent: true,
              preview: { kind: "note", text: "install gitty" },
            }),
            untrustedGitConfig,
          },
          {
            ...describeOperation({
              capabilityId: "gitty",
              resourceId: "shared:gitty",
              targetPath: "",
              action: "use-shared",
              riskClass: "inert",
              requiresConsent: false,
              preview: { kind: "note", text: "use gitty" },
            }),
            untrustedGitConfig,
          },
        ];
      },
      async apply(_ctx, operations) {
        appliedByGitty.push(...operations.map(({ action }) => action));
      },
      async install() {},
      async verify() {
        return { ok: true };
      },
      async uninstall() {},
    };
    return { plugin: gitty, applied: appliedByGitty };
  }

  it("skips operations whose untrusted git config cannot be approved, applies the rest and ends in drift", async () => {
    const gatedOperationIds: string[] = [];
    const context = await createTestContext((gates) => {
      gatedOperationIds.push(
        ...gates.flatMap((gate) => gate.operations.map(({ id }) => id)),
      );
      return approveEveryGate(gates);
    });
    const alpha = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });
    const gitty = createGitConfigCapability({
      kind: "unshowable",
      fingerprint: "b".repeat(64),
    });

    await expect(
      reconcile(context, [alpha.plugin, gitty.plugin], RECONCILE_OPTIONS),
    ).resolves.toBe("drift");

    expect(alpha.installCallCount()).toBe(1);
    expect(gitty.applied).toEqual([]);
    expect(gatedOperationIds.some((id) => id.startsWith("gitty"))).toBe(false);
  });

  it("routes approvable untrusted git config, including use-shared, only into the trust gate", async () => {
    const gatesSeen: ConsentGate[] = [];
    const context = await createTestContext((gates) => {
      gatesSeen.push(...gates);
      return approveEveryGate(gates);
    });
    const gitty = createGitConfigCapability({
      kind: "pairs",
      pairs: [".git/config: diff.x.command=/tmp/differ"],
      fingerprint: "b".repeat(64),
    });

    await expect(
      reconcile(context, [gitty.plugin], {
        ...RECONCILE_OPTIONS,
        trustRepoGitConfig: true,
      }),
    ).resolves.toBe("applied");

    expect(gatesSeen.map((gate) => gate.id)).toEqual([
      "trust-repository-git-config",
    ]);
    expect(gatesSeen[0].satisfiableWithYes).toBe(true);
    expect(gitty.applied).toEqual(["install-package", "use-shared"]);
  });

  it("applies no carrying operation, use-shared included, when the trust gate is declined", async () => {
    const context = await createTestContext(skipEveryOperation(false));
    const gitty = createGitConfigCapability({
      kind: "pairs",
      pairs: [".git/config: diff.x.command=/tmp/differ"],
      fingerprint: "b".repeat(64),
    });

    await expect(
      reconcile(context, [gitty.plugin], RECONCILE_OPTIONS),
    ).resolves.toBe("declined");

    expect(gitty.applied).toEqual([]);
  });

  it("prints an installed capability's attention even when there is nothing to apply", async () => {
    const context = await createTestContext(approveEveryGate);
    const infos: string[] = [];
    context.ui = { ...context.ui, info: (line) => infos.push(line) };
    await context.manifest.recordAction({
      plugin: "watched",
      type: "installed-binary",
      target: "watched",
      preExisting: false,
    });
    const watched: AgemonPlugin = {
      id: "watched",
      async detect() {
        return { present: true, preExisting: false };
      },
      async plan() {
        return [];
      },
      async install() {},
      async verify() {
        return { ok: true, attention: "untrusted repository git config" };
      },
      async uninstall() {},
    };

    await expect(
      reconcile(context, [watched], RECONCILE_OPTIONS),
    ).resolves.toBe("nothing-to-do");

    expect(infos).toContain("watched: untrusted repository git config");
  });

  it("returns 'drift' after an apply that left an operation without consent", async () => {
    const context = await createTestContext(async (gates) => {
      const [first, ...rest] = gates.flatMap((gate) => gate.operations);
      return {
        approved: [first],
        skipped: rest.map((operation) => ({
          operation,
          reason: "unresolved",
          consentMissing: true,
        })),
        workspaceIsolationApproved: true,
        conflictResolutions: [],
      };
    });
    const alpha = createFakeCapability({ id: "alpha", targetPath: "a.txt" });
    const beta = createFakeCapability({ id: "beta", targetPath: "b.txt" });

    await expect(
      reconcile(context, [alpha.plugin, beta.plugin], RECONCILE_OPTIONS),
    ).resolves.toBe("drift");
    expect(alpha.installCallCount()).toBe(1);
  });

  it("returns 'nothing-to-do' when every pending operation is a settled conflict", async () => {
    const context = await createTestContext(skipEveryOperation(false));
    await writeFile(
      join(context.cwd, "CLAUDE.md"),
      "# Claude\n\nIndependent rules.\n",
      "utf8",
    );
    context.consent = approveEveryGate;
    await reconcile(context, [masterPromptPlugin], RECONCILE_OPTIONS);
    context.consent = async (gates) => {
      const operations = gates.flatMap((gate) => gate.operations);
      expect(operations.map((operation) => operation.action)).toEqual([
        "conflict",
      ]);
      return skipEveryOperation(false)(gates);
    };

    await expect(
      reconcile(context, [masterPromptPlugin], RECONCILE_OPTIONS),
    ).resolves.toBe("nothing-to-do");
  });

  it("runs nothing and returns 'nothing-to-do' for an explicitly empty selection", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin, planCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    await expect(
      reconcile(context, [plugin], { ...RECONCILE_OPTIONS, only: [] }),
    ).resolves.toBe("nothing-to-do");
    expect(planCallCount()).toBe(0);
  });
});

describe("uninstallPlugins", () => {
  interface Uninstallable {
    plugin: AgemonPlugin;
  }

  function uninstallable(
    id: string,
    uninstalled: string[],
    options: { dependsOn?: string[]; failsWith?: string } = {},
  ): Uninstallable {
    return {
      plugin: {
        id,
        dependsOn: options.dependsOn,
        riskClass: "executes",
        async detect() {
          return { present: true, preExisting: false };
        },
        async install() {},
        async verify() {
          return { ok: true };
        },
        async uninstall(ctx) {
          if (ctx.dryRun) {
            ctx.ui.info(`Would remove ${id}`);
            return;
          }
          if (options.failsWith) {
            throw new Error(options.failsWith);
          }
          uninstalled.push(id);
        },
      },
    };
  }

  async function createNukeContext(ledgerPluginIds: string[]): Promise<{
    ctx: Context;
    printed: string[];
    configPath: string;
  }> {
    const ctx = await createTestContext(approveEveryGate);
    const printed: string[] = [];
    ctx.log = {
      log: (message: string) => printed.push(message),
      error() {},
    };
    ctx.ui = {
      ...ctx.ui,
      info: (line: string) => printed.push(line),
    };
    for (const plugin of ledgerPluginIds) {
      await ctx.manifest.recordAction({
        plugin,
        type: "fake",
        target: `${plugin}-target`,
        preExisting: false,
      });
    }
    const configPath = join(ctx.cwd, "agemon.toml");
    await writeFile(configPath, 'capabilities = ["base"]\n', "utf8");
    return { ctx, printed, configPath };
  }

  function ledgerPlugins(ctx: Context): string[] {
    return ctx.manifest.getActions().map((entry) => entry.plugin);
  }

  async function exists(path: string): Promise<boolean> {
    return readFile(path).then(
      () => true,
      () => false,
    );
  }

  it("keeps going past a failing plugin, then reports it and keeps its entries", async () => {
    const uninstalled: string[] = [];
    const { ctx, configPath } = await createNukeContext(["a", "b", "c"]);
    const plugins = [
      uninstallable("a", uninstalled).plugin,
      uninstallable("b", uninstalled, { failsWith: "b broke" }).plugin,
      uninstallable("c", uninstalled).plugin,
    ];

    await expect(uninstallPlugins(ctx, plugins, {})).rejects.toThrow(
      "nuke could not reverse b (b broke). Their ledger entries are kept — fix the cause and re-run 'agemon nuke'.",
    );

    expect(uninstalled).toEqual(["c", "a"]);
    expect(ledgerPlugins(ctx)).toEqual(["b"]);
    expect(await exists(configPath)).toBe(true);
  });

  it("keeps a dependency whose dependent could not be uninstalled", async () => {
    const uninstalled: string[] = [];
    const { ctx, printed } = await createNukeContext(["base", "dependent"]);
    const plugins = [
      uninstallable("base", uninstalled).plugin,
      uninstallable("dependent", uninstalled, {
        dependsOn: ["base"],
        failsWith: "systemctl failed",
      }).plugin,
    ];

    await expect(uninstallPlugins(ctx, plugins, {})).rejects.toThrow(
      /dependent \(systemctl failed\)/,
    );

    expect(uninstalled).toEqual([]);
    expect(printed).toContain(
      "kept: base (dependent could not be uninstalled)",
    );
    expect(ledgerPlugins(ctx)).toEqual(["base", "dependent"]);
  });

  it("keeps a dependency of a skipped plugin that is still installed", async () => {
    const uninstalled: string[] = [];
    const { ctx, printed } = await createNukeContext(["base", "dependent"]);
    const plugins = [
      uninstallable("base", uninstalled).plugin,
      uninstallable("dependent", uninstalled, { dependsOn: ["base"] }).plugin,
    ];

    await expect(
      uninstallPlugins(ctx, plugins, { skipIds: ["dependent"] }),
    ).resolves.toBe("applied");

    expect(uninstalled).toEqual([]);
    expect(printed).toContain("kept: base (dependent is still installed)");
  });

  it("removes the dependency and agemon.toml when the skipped dependent was never installed", async () => {
    const uninstalled: string[] = [];
    const { ctx, configPath } = await createNukeContext(["base"]);
    const plugins = [
      uninstallable("base", uninstalled).plugin,
      uninstallable("dependent", uninstalled, { dependsOn: ["base"] }).plugin,
    ];

    await expect(
      uninstallPlugins(ctx, plugins, { skipIds: ["dependent"] }),
    ).resolves.toBe("applied");

    expect(uninstalled).toEqual(["base"]);
    expect(ledgerPlugins(ctx)).toEqual([]);
    expect(await exists(configPath)).toBe(false);
  });

  it("does not pull in dependencies when only a dependent is requested", async () => {
    const uninstalled: string[] = [];
    const { ctx } = await createNukeContext(["base", "dependent"]);
    const plugins = [
      uninstallable("base", uninstalled).plugin,
      uninstallable("dependent", uninstalled, { dependsOn: ["base"] }).plugin,
    ];

    await uninstallPlugins(ctx, plugins, { only: ["dependent"] });

    expect(uninstalled).toEqual(["dependent"]);
    expect(ledgerPlugins(ctx)).toEqual(["base"]);
  });

  it("keeps agemon.toml in a fresh clone when nuke --only removes nothing", async () => {
    const uninstalled: string[] = [];
    const { ctx, configPath } = await createNukeContext([]);

    await uninstallPlugins(ctx, [uninstallable("base", uninstalled).plugin], {
      only: ["base"],
    });

    expect(await exists(configPath)).toBe(true);
  });

  it("returns 'declined' and changes nothing when the user says no", async () => {
    const uninstalled: string[] = [];
    const { ctx } = await createNukeContext(["base"]);
    ctx.yes = false;
    ctx.interactive = true;
    const questions: string[] = [];
    ctx.confirm = async (question) => {
      questions.push(question);
      return false;
    };

    await expect(
      uninstallPlugins(ctx, [uninstallable("base", uninstalled).plugin], {}),
    ).resolves.toBe("declined");

    expect(questions).toEqual(["Reverse these changes?"]);
    expect(uninstalled).toEqual([]);
    expect(ledgerPlugins(ctx)).toEqual(["base"]);
  });

  it("lists what it would reverse and stops without --yes when nobody can answer", async () => {
    const uninstalled: string[] = [];
    const { ctx, printed, configPath } = await createNukeContext(["base"]);
    ctx.yes = false;
    const statePath = join(ctx.cwd, ".agemon/state.json");
    const stateBefore = await readFile(statePath, "utf8");

    await expect(
      uninstallPlugins(ctx, [uninstallable("base", uninstalled).plugin], {}),
    ).resolves.toBe("previewed");

    expect(printed.join("\n")).toContain(
      "agemon nuke will reverse:\n  base:\n    Would remove base\n  agemon.toml (deleted)",
    );
    expect(printed).toContain("Re-run with --yes to reverse these changes.");
    expect(uninstalled).toEqual([]);
    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
    expect(await exists(configPath)).toBe(true);
  });

  it("leaves the ledger and agemon.toml byte-identical under --dry-run", async () => {
    const uninstalled: string[] = [];
    const { ctx, configPath } = await createNukeContext(["base"]);
    ctx.dryRun = true;
    const statePath = join(ctx.cwd, ".agemon/state.json");
    const stateBefore = await readFile(statePath, "utf8");
    const configBefore = await readFile(configPath, "utf8");

    await expect(
      uninstallPlugins(ctx, [uninstallable("base", uninstalled).plugin], {}),
    ).resolves.toBe("previewed");

    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
    await expect(readFile(configPath, "utf8")).resolves.toBe(configBefore);
  });

  function previewing(
    id: string,
    previewLines: string[] | Error,
  ): AgemonPlugin {
    const plugin = uninstallable(id, []).plugin;
    return {
      ...plugin,
      async uninstall(ctx) {
        if (!ctx.dryRun) {
          return;
        }
        if (previewLines instanceof Error) {
          throw previewLines;
        }
        for (const line of previewLines) {
          ctx.ui.info(line);
        }
      },
    };
  }

  async function previewOf(
    plugins: AgemonPlugin[],
    ledgerPluginIds: string[],
  ): Promise<string> {
    const { ctx, printed } = await createNukeContext(ledgerPluginIds);
    ctx.yes = false;
    await uninstallPlugins(ctx, plugins, {});
    return printed.join("\n");
  }

  it("keeps a forged ledger target on one line so it cannot fake a 'kept:' line", async () => {
    const preview = await previewOf(
      [previewing("skills", ["Would remove skill x\nkept: crg (fake)"])],
      ["skills"],
    );

    expect(preview).not.toMatch(/^\s*kept: crg/m);
    expect(preview).toContain("Would remove skill x kept: crg (fake)");
  });

  it("caps each plugin's preview so one plugin cannot hide another's effects", async () => {
    const flood = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const preview = await previewOf(
      [
        previewing("crg", ["Would uninstall code-review-graph from pipx"]),
        previewing("skills", flood),
      ],
      ["crg", "skills"],
    );

    expect(preview).toContain(
      "… 10 more — run 'agemon nuke --dry-run' for the full list",
    );
    expect(preview).toContain("Would uninstall code-review-graph from pipx");
    expect(preview).toContain("agemon.toml (deleted)");
  });

  it("lists a plugin whose preview fails instead of aborting", async () => {
    const preview = await previewOf(
      [previewing("skills", new Error("listing failed\nsecond line"))],
      ["skills"],
    );

    expect(preview).toContain("could not preview (listing failed)");
  });

  it("stops when a plugin tries to ask a question during the preview", async () => {
    const { ctx } = await createNukeContext(["base"]);
    ctx.yes = false;
    const prompting: AgemonPlugin = {
      ...uninstallable("base", []).plugin,
      async uninstall(previewCtx) {
        await previewCtx.confirm("really?");
      },
    };

    await expect(uninstallPlugins(ctx, [prompting], {})).rejects.toThrow(
      "the nuke preview must not ask for consent",
    );
    expect(ledgerPlugins(ctx)).toEqual(["base"]);
  });

  it.each([
    [
      "a subprocess",
      (previewCtx: Context) => previewCtx.run("git", ["status"]),
    ],
    [
      "unregisterAutostart",
      (previewCtx: Context) =>
        previewCtx.serviceManager.unregisterAutostart({
          unitName: "agemon-crg-daemon-x-01234567.service",
        }),
    ],
    [
      "isLingerEnabled",
      (previewCtx: Context) => previewCtx.serviceManager.isLingerEnabled(),
    ],
    [
      "disableLinger",
      (previewCtx: Context) => previewCtx.serviceManager.disableLinger(),
    ],
    [
      "registerAutostart",
      (previewCtx: Context) =>
        previewCtx.serviceManager.registerAutostart({
          unitName: "agemon-crg-daemon-x-01234567.service",
          attempts: [],
        }),
    ],
    [
      "isActive",
      (previewCtx: Context) =>
        previewCtx.serviceManager.isActive(
          "agemon-crg-daemon-x-01234567.service",
        ),
    ],
    [
      "isSandboxEnforced",
      (previewCtx: Context) =>
        previewCtx.serviceManager.isSandboxEnforced(
          "agemon-crg-daemon-x-01234567.service",
        ),
    ],
  ])("nuke preview refuses %s", async (_case, act) => {
    const { ctx } = await createNukeContext(["base"]);
    ctx.yes = false;
    const acting: AgemonPlugin = {
      ...uninstallable("base", []).plugin,
      async uninstall(previewCtx) {
        await act(previewCtx);
      },
    };

    await expect(uninstallPlugins(ctx, [acting], {})).rejects.toThrow(
      "the nuke preview must not run commands",
    );
    expect(ledgerPlugins(ctx)).toEqual(["base"]);
  });

  it("asks before deleting agemon.toml even when the ledger is empty", async () => {
    const { ctx, configPath, printed } = await createNukeContext([]);
    ctx.yes = false;

    await expect(
      uninstallPlugins(ctx, [uninstallable("base", []).plugin], {}),
    ).resolves.toBe("previewed");

    expect(await exists(configPath)).toBe(true);
    expect(printed.join("\n")).toContain("agemon.toml (deleted)");
  });

  it("deletes agemon.toml with --yes when the ledger is empty", async () => {
    const { ctx, configPath } = await createNukeContext([]);

    await uninstallPlugins(ctx, [uninstallable("base", []).plugin], {});

    expect(await exists(configPath)).toBe(false);
  });

  it("reports only the first, redacted line of a failure", async () => {
    const { ctx } = await createNukeContext(["base"]);
    const plugins = [
      uninstallable("base", [], {
        failsWith:
          "npm ERR! //registry.npmjs.org/:_authToken=npm_secret\nmore detail",
      }).plugin,
    ];

    const failure = await uninstallPlugins(ctx, plugins, {}).catch(
      (error: Error) => error.message,
    );

    expect(failure).toContain(
      "base (npm ERR! //registry.npmjs.org/:_authToken=<redacted:credential-key>)",
    );
    expect(failure).not.toContain("npm_secret");
    expect(failure).not.toContain("more detail");
  });
});

describe("reconcile with use-shared operations", () => {
  const AGNIX_RESOURCE = {
    id: "npm-global:agnix" as const,
    toolName: "agnix",
    manualRemoveCommand: "npm uninstall --global agnix",
    removalVerb: "uninstall" as const,
    migratesFromRepoLedgers: true,
  };

  function useSharedOperation(targetPath: string = AGNIX_RESOURCE.id) {
    return describeOperation({
      capabilityId: "shared-cap",
      resourceId: targetPath,
      targetPath,
      action: "use-shared",
      riskClass: "inert",
      requiresConsent: false,
      preview: { kind: "note", text: "record that this repository uses agnix" },
    });
  }

  function createSharingCapability(
    extra: ReturnType<typeof describeOperation>[] = [],
  ) {
    const applied: string[][] = [];
    const plugin: AgemonPlugin = {
      id: "shared-cap",
      sharedResources: [AGNIX_RESOURCE],
      async detect() {
        return { present: true, preExisting: true };
      },
      async plan() {
        return [useSharedOperation(), ...extra];
      },
      async apply(_ctx, operations) {
        applied.push(operations.map((operation) => operation.action));
      },
      async install() {},
      async verify() {
        return { ok: true };
      },
      async uninstall() {},
    };
    return { plugin, applied };
  }

  const installOperation = describeOperation({
    capabilityId: "shared-cap",
    resourceId: "package:agnix",
    targetPath: "agnix",
    action: "install-package",
    riskClass: "executes",
    requiresConsent: true,
    preview: { kind: "note", text: "install agnix" },
  });

  it("a plan with only use-shared ops (no gates) applies them", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const { plugin, applied } = createSharingCapability();

    const outcome = await reconcile(ctx, [plugin], RECONCILE_OPTIONS);

    expect(outcome).toBe("applied");
    expect(applied).toEqual([["use-shared"]]);
  });

  it("declining every gate still applies use-shared ops", async () => {
    const ctx = await createTestContext(async (gates) => ({
      approved: [],
      skipped: gates.flatMap((gate) =>
        gate.operations.map((operation) => ({
          operation,
          reason: "declined",
          consentMissing: false,
        })),
      ),
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }));
    const { plugin, applied } = createSharingCapability([installOperation]);

    await reconcile(ctx, [plugin], RECONCILE_OPTIONS);

    expect(applied).toEqual([["use-shared"]]);
  });

  it("a non-interactive first run with only use-shared ops stops at the preview when /.agemon/ is not ignored", async () => {
    const ctx = await createTestContext(approveEveryGate);
    await rm(join(ctx.cwd, ".gitignore"));
    const { plugin, applied } = createSharingCapability();

    const outcome = await reconcile({ ...ctx, yes: false }, [plugin], {
      ...RECONCILE_OPTIONS,
      persistConfig: true,
    });

    expect(outcome).toBe("previewed");
    expect(applied).toEqual([]);
  });

  it("a non-interactive first run with only use-shared ops applies them in an ignored repo", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const { plugin, applied } = createSharingCapability();

    const outcome = await reconcile({ ...ctx, yes: false }, [plugin], {
      ...RECONCILE_OPTIONS,
      persistConfig: true,
    });

    expect(outcome).toBe("applied");
    expect(applied).toEqual([["use-shared"]]);
  });

  it("skips use-shared ops when /.agemon/ may not be git-ignored", async () => {
    const ctx = await createTestContext(async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: false,
      conflictResolutions: [],
    }));
    await rm(join(ctx.cwd, ".gitignore"));
    const { plugin, applied } = createSharingCapability();

    const outcome = await reconcile(ctx, [plugin], RECONCILE_OPTIONS);

    expect(outcome).toBe("declined");
    expect(applied).toEqual([]);
  });

  it.each([
    ["a tool the plugin does not manage", "pipx:code-review-graph"],
    ["an option-like target", "--global"],
  ])(
    "refuses a stored plan whose use-shared op names %s",
    async (_label, target) => {
      const ctx = await createTestContext(approveEveryGate);
      const { plugin, applied } = createSharingCapability();
      const plan = await buildPlan(ctx, [plugin], { agemonVersion: "9.9.9" });
      const forged: Plan = {
        ...plan,
        operations: [useSharedOperation(target)],
      };

      await expect(
        reconcile(ctx, [plugin], { ...RECONCILE_OPTIONS, plan: forged }),
      ).rejects.toThrow(/which it does not manage/);
      expect(applied).toEqual([]);
    },
  );

  it("refuses a use-shared op whose resource id names a foreign tool", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const { plugin, applied } = createSharingCapability();
    const plan = await buildPlan(ctx, [plugin], { agemonVersion: "9.9.9" });
    const forged: Plan = {
      ...plan,
      operations: [
        { ...useSharedOperation(), resourceId: "pipx:code-review-graph" },
      ],
    };

    await expect(
      reconcile(ctx, [plugin], { ...RECONCILE_OPTIONS, plan: forged }),
    ).rejects.toThrow(/which it does not manage/);
    expect(applied).toEqual([]);
  });

  it("a stored plan with a use-shared op round-trips, applies, and creates no repo file", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const { plugin, applied } = createSharingCapability();
    const plan = await buildPlan(ctx, [plugin], { agemonVersion: "9.9.9" });
    await writePlan(ctx.cwd, plan);
    const stored = await readPlan(ctx.cwd, plan.id);

    const outcome = await reconcile(ctx, [plugin], {
      ...RECONCILE_OPTIONS,
      plan: stored,
    });

    expect(outcome).toBe("applied");
    expect(applied).toEqual([["use-shared"]]);
    expect((await readdir(ctx.cwd)).sort()).toEqual([".agemon", ".gitignore"]);
  });

  it("refuses a use-shared op for a plugin that declares no shared tools", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const { plugin } = createSharingCapability();
    const plan = await buildPlan(ctx, [plugin], { agemonVersion: "9.9.9" });
    const withoutSharedTools = { ...plugin, sharedResources: undefined };

    await expect(
      reconcile(ctx, [withoutSharedTools], { ...RECONCILE_OPTIONS, plan }),
    ).rejects.toThrow(/which it does not manage/);
  });
});

describe("the state directory is checked before any work", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function looseStateRoot(): Promise<void> {
    const stateRoot = await mkdtemp(join(tmpdir(), "agemon-loose-state-"));
    createdTempDirectories.push(stateRoot);
    await mkdir(join(stateRoot, "agemon"), { mode: 0o700 });
    await chmod(join(stateRoot, "agemon"), 0o707);
    vi.stubEnv("XDG_STATE_HOME", stateRoot);
  }

  it("reconcile refuses before planning", async () => {
    const ctx = await createTestContext(approveEveryGate);
    const capability = createFakeCapability({
      id: "fake",
      targetPath: "FAKE.md",
    });
    await looseStateRoot();

    await expect(
      reconcile(ctx, [capability.plugin], RECONCILE_OPTIONS),
    ).rejects.toThrow(/other users can write to it/);
    expect(capability.planCallCount()).toBe(0);
  });

  it("nuke refuses before reversing anything", async () => {
    const ctx = await createTestContext(approveEveryGate);
    await looseStateRoot();

    await expect(uninstallPlugins(ctx, [], {})).rejects.toThrow(
      /other users can write to it/,
    );
  });

  it("recover refuses before reading journals", async () => {
    const ctx = await createTestContext(approveEveryGate);
    await looseStateRoot();

    await expect(
      recoverInterruptedApply(ctx, [], { dryRun: false }),
    ).rejects.toThrow(/other users can write to it/);
  });
});

describe("printing ledger targets", () => {
  it("nuke --dry-run prints a zero-width character in a ledger target as '?'", async () => {
    const ctx = await createTestContext(approveEveryGate);
    await ctx.manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS\u200b.md",
      preExisting: false,
    });
    const lines: string[] = [];
    const preview = {
      ...ctx,
      dryRun: true,
      ui: { ...ctx.ui, info: (line: string) => lines.push(line) },
    };

    await uninstallPlugins(preview, [masterPromptPlugin], {});

    const printed = lines.join("\n");
    expect(printed).toContain("AGENTS?.md");
    expect(printed).not.toContain("\u200b");
  });
});
