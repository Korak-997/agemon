import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApprovedOperationSet,
  ConsentGate,
} from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import { reconcile } from "../../../src/core/orchestrator.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import type { AgemonPlugin } from "../../../src/plugins/types.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function createNoOpServiceManager(): ServiceManager {
  return {
    async isActive() {
      return { active: false };
    },
    async registerAutostart() {
      return { unitPath: "", lingerEnabledByAgemon: false };
    },
    async unregisterAutostart() {
      return;
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
    os: "ubuntu",
    binaries: [],
    dryRun: false,
    yes: true,
    log: console,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    confirm: async () => false,
    consent,
  };
}

interface FakeCapabilityOptions {
  id: string;
  targetPath: string;
}

function createFakeCapability(options: FakeCapabilityOptions): {
  plugin: AgemonPlugin;
  planCallCount: () => number;
  installCallCount: () => number;
} {
  let planCalls = 0;
  let installCalls = 0;
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
      async install(ctx) {
        installCalls += 1;
        await writeFile(
          join(ctx.cwd, options.targetPath),
          `written by ${options.id}\n`,
          "utf8",
        );
      },
      async verify() {
        return { ok: true };
      },
      async uninstall() {
        return;
      },
    },
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

  it("makes no changes when consent declines every operation", async () => {
    const context = await createTestContext(async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: false,
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
      only: "alpha",
    });

    expect(alpha.installCallCount()).toBe(1);
    expect(beta.installCallCount()).toBe(0);
  });

  it("uses a supplied plan instead of rebuilding one", async () => {
    const context = await createTestContext(approveEveryGate);
    const { plugin, planCallCount, installCallCount } = createFakeCapability({
      id: "alpha",
      targetPath: "alpha.txt",
    });

    const suppliedPlan: Plan = {
      id: "supplied-plan",
      agemonVersion: "9.9.9",
      desiredStateHash: "hash",
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
    };

    await reconcile(context, [plugin], {
      ...RECONCILE_OPTIONS,
      plan: suppliedPlan,
    });

    expect(planCallCount()).toBe(0);
    expect(installCallCount()).toBe(1);
    await expect(
      readFile(join(context.cwd, ".agemon/plans/supplied-plan.json"), "utf8"),
    ).resolves.toContain("supplied-plan");
  });
});
