import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
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
    confirm: async () => false,
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

    await cliToolPlugin.uninstall(context);

    const verificationAfterUninstall = await cliToolPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
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

    await cliToolPlugin.uninstall(context);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
  });
});
