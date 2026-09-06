import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { buildPlan } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { getRegisteredPlugins } from "../../../src/plugins/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";

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

async function createTestContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-build-plan-"));
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
    binaries: [],
    dryRun: true,
    yes: false,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: async (_command: string, args: string[]) =>
      args.includes("--version")
        ? { code: 1, stdout: "", stderr: "not installed" }
        : { code: 0, stdout: "", stderr: "" },
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
  };
}

const PLAN_OPTIONS = { agemonVersion: "9.9.9" } as const;

describe("buildPlan", () => {
  it("produces an identical id and operation set across repeated runs", async () => {
    const context = await createTestContext();

    const first = await buildPlan(
      context,
      getRegisteredPlugins(),
      PLAN_OPTIONS,
    );
    const second = await buildPlan(
      context,
      getRegisteredPlugins(),
      PLAN_OPTIONS,
    );

    expect(second.id).toBe(first.id);
    expect(second.operations).toEqual(first.operations);
    expect(second.desiredStateHash).toBe(first.desiredStateHash);
  });

  it("plans every absent rule file as a create", async () => {
    const context = await createTestContext();

    const plan = await buildPlan(context, [masterPromptPlugin], {
      ...PLAN_OPTIONS,
      only: "master-prompt",
    });

    expect(plan.operations).toHaveLength(5);
    expect(
      plan.operations.every((operation) => operation.action === "create"),
    ).toBe(true);
  });

  it("plans nothing once the rule files are already managed", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install({ ...context, dryRun: false });

    const plan = await buildPlan(context, [masterPromptPlugin], {
      ...PLAN_OPTIONS,
      only: "master-prompt",
    });

    expect(plan.operations).toEqual([]);
  });

  it("orders a dependency's operations ahead of its dependents", async () => {
    const context = await createTestContext();

    const plan = await buildPlan(context, getRegisteredPlugins(), {
      ...PLAN_OPTIONS,
      only: "daemon",
    });

    const capabilityOrder = plan.operations.map(
      (operation) => operation.capabilityId,
    );
    expect(capabilityOrder.indexOf("crg")).toBeGreaterThanOrEqual(0);
    expect(capabilityOrder.indexOf("crg")).toBeLessThan(
      capabilityOrder.indexOf("daemon"),
    );
  });
});
