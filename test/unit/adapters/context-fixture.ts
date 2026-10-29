import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

function createNoOpServiceManager(): ServiceManager {
  return {
    kind: "systemd-user",
    async isActive() {
      return { active: false };
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
  return { start() {}, succeed() {}, fail() {}, info() {} };
}

export interface CreateAdapterTestContextOptions {
  confirm?: (message: string) => Promise<boolean>;
  cwd?: string;
}

export async function createAdapterTestContext(
  options: CreateAdapterTestContextOptions = {},
): Promise<Context> {
  const sandboxDirectory =
    options.cwd ?? (await mkdtemp(join(tmpdir(), "agemon-adapters-test-")));

  return {
    cwd: sandboxDirectory,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    confirm: options.confirm ?? (async () => false),
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: createNoOpUi(),
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}
