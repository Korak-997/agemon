import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { cliToolPlugin } from "../../../src/plugins/cli-tool/index.js";

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
      return {
        unitPath: "",
        lingerEnabledByAgemon: false,
      };
    },
    async unregisterAutostart() {
      return;
    },
  };
}

function createNoOpUi(): Context["ui"] {
  return {
    start() {
      return;
    },
    succeed() {
      return;
    },
    fail() {
      return;
    },
    info() {
      return;
    },
  };
}

async function createTestContext(
  preinstalledPackages?: string,
): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-cli-tool-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  if (preinstalledPackages) {
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES = preinstalledPackages;
  } else {
    delete process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES;
  }

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
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
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
  };
}

describe("cli-tool plugin", () => {
  it("installs, verifies, and uninstalls managed CLI tools", async () => {
    const context = await createTestContext();

    const detectedBeforeInstall = await cliToolPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await cliToolPlugin.install(context);

    const verificationAfterInstall = await cliToolPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterInstall).toHaveLength(1);
    expect(actionsAfterInstall[0]?.preExisting).toBe(false);
    expect(actionsAfterInstall[0]?.target).toBe("agnix");

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    const verificationAfterUninstall = await cliToolPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
  });

  it("leaves the ledger to the orchestrator when uninstalled directly", async () => {
    const context = await createTestContext();
    await cliToolPlugin.install(context);
    const ledgerBefore = context.manifest.getActions();

    await cliToolPlugin.uninstall(context);

    expect(context.manifest.getActions()).toEqual(ledgerBefore);
  });

  it("records pre-existing CLI tools without managing uninstall", async () => {
    const context = await createTestContext("agnix");

    const detected = await cliToolPlugin.detect(context);
    expect(detected.present).toBe(true);
    expect(detected.preExisting).toBe(true);

    const actionsAfterDetect = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterDetect).toHaveLength(1);
    expect(actionsAfterDetect[0]?.preExisting).toBe(true);

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
  });

  it("never uninstalls a package whose ledger target is not a bundle tool", async () => {
    const context = await createTestContext();
    const commands: string[][] = [];
    context.run = async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const messages: string[] = [];
    context.ui = { ...context.ui, info: (message) => messages.push(message) };
    await context.manifest.recordAction({
      plugin: "cli-tool",
      type: "installed-cli-tool",
      target: "typescript",
      preExisting: false,
    });

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    expect(commands).toEqual([]);
    expect(messages).toContain(
      "ignoring ledger entry for typescript: cli-tool does not manage that package",
    );
    expect(context.manifest.getActions()).toEqual([]);
  });
});
