import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { getRegisteredPlugins } from "../../../src/plugins/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import { testPlugin } from "../../../src/plugins/test-plugin.js";
import { applyAllPlanned } from "../apply-all-planned.js";
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

function createNoOpUi(): Context["ui"] {
  return {
    start() {},
    succeed() {},
    fail() {},
    info() {},
  };
}

async function createTestContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-plan-test-"));
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: createNoOpUi(),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

describe("capability plan()", () => {
  it("is implemented with a risk class on every registered capability", () => {
    const capabilities = [...getRegisteredPlugins(), testPlugin];

    for (const capability of capabilities) {
      expect(typeof capability.plan, capability.id).toBe("function");
      expect(capability.riskClass, capability.id).toBeDefined();
    }
  });

  it("emits one whole-file operation per missing rule file, and none when they match", async () => {
    const context = await createTestContext();

    const freshPlan = await masterPromptPlugin.plan?.(context);
    expect(freshPlan).toHaveLength(5);
    expect(freshPlan?.every((operation) => operation.action === "create")).toBe(
      true,
    );
    expect(
      freshPlan?.every((operation) => operation.expectedFingerprint === null),
    ).toBe(true);

    await applyAllPlanned(masterPromptPlugin, context);

    const settledPlan = await masterPromptPlugin.plan?.(context);
    expect(settledPlan).toEqual([]);
  });

  it("produces a byte-identical plan for unchanged repo state", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "AGENTS.md"), "hand written\n", "utf8");

    const first = await masterPromptPlugin.plan?.(context);
    const second = await masterPromptPlugin.plan?.(context);

    expect(second).toEqual(first);
    const agentsOperation = first?.find(
      (operation) => operation.targetPath === "AGENTS.md",
    );
    expect(agentsOperation?.action).toBe("merge-block");
    expect(agentsOperation?.expectedFingerprint).not.toBeNull();
  });
});
