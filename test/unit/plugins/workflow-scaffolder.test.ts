import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { workflowScaffolderPlugin } from "../../../src/plugins/workflow-scaffolder/index.js";

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

async function createTestContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-workflow-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
    binaries: [],
    dryRun: false,
    yes: true,
    confirm: async () => false,
    log: console,
    ui: createNoOpUi(),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
  };
}

describe("workflow-scaffolder plugin", () => {
  it("installs, verifies, and uninstalls managed workflows", async () => {
    const context = await createTestContext();

    const detectedBeforeInstall =
      await workflowScaffolderPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await workflowScaffolderPlugin.install(context);

    const verificationAfterInstall =
      await workflowScaffolderPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "workflow-scaffolder");
    expect(actionsAfterInstall.length).toBe(2);
    expect(
      actionsAfterInstall.every((action) => action.preExisting === false),
    ).toBe(true);

    const firstWorkflowPath = join(
      context.cwd,
      ".github/workflows/claude-code-security-review.yml",
    );
    const secondWorkflowPath = join(
      context.cwd,
      ".github/workflows/code-review-graph-action.yml",
    );

    expect(existsSync(firstWorkflowPath)).toBe(true);
    expect(existsSync(secondWorkflowPath)).toBe(true);

    const firstWorkflowContents = await readFile(firstWorkflowPath, "utf8");
    expect(
      firstWorkflowContents.includes(
        "anthropics/claude-code-security-review@main",
      ),
    ).toBe(true);

    await workflowScaffolderPlugin.uninstall(context);

    const verificationAfterUninstall =
      await workflowScaffolderPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "workflow-scaffolder");
    expect(actionsAfterUninstall).toEqual([]);
    expect(existsSync(firstWorkflowPath)).toBe(false);
    expect(existsSync(secondWorkflowPath)).toBe(false);
  });

  it("fails detect on unmanaged workflow collisions", async () => {
    const context = await createTestContext();
    const collisionDirectoryPath = join(context.cwd, ".github/workflows");
    const collidingWorkflowPath = join(
      collisionDirectoryPath,
      "claude-code-security-review.yml",
    );

    await mkdir(collisionDirectoryPath, { recursive: true });
    await writeFile(collidingWorkflowPath, "name: Existing\n", "utf8");

    await expect(workflowScaffolderPlugin.detect(context)).rejects.toThrow(
      "Refusing to overwrite pre-existing workflow file(s)",
    );

    const untouchedWorkflowPath = join(
      context.cwd,
      ".github/workflows/code-review-graph-action.yml",
    );
    expect(existsSync(untouchedWorkflowPath)).toBe(false);

    const actions = context.manifest
      .getActions()
      .filter((action) => action.plugin === "workflow-scaffolder");
    expect(actions).toEqual([]);
  });
});
