import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
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
    join(tmpdir(), "agemon-master-prompt-test-"),
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

describe("master-prompt plugin", () => {
  it("consolidates messy rule files and restores them on uninstall", async () => {
    const context = await createTestContext();

    const initialContentsByTarget = new Map<string, string>([
      ["AGENTS.md", "# Legacy agent guide\n\nOutdated policy text.\n"],
      ["CLAUDE.md", "# Claude local notes\n\nDo not share.\n"],
      [".cursorrules", "legacy cursor rules\n"],
    ]);

    for (const [target, contents] of initialContentsByTarget) {
      await writeFile(join(context.cwd, target), contents, "utf8");
    }

    const detectedBeforeInstall = await masterPromptPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await masterPromptPlugin.install(context);

    const verificationAfterInstall = await masterPromptPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const consolidatedAgentsContents = await readFile(
      join(context.cwd, "AGENTS.md"),
      "utf8",
    );
    expect(consolidatedAgentsContents.includes("# AI Agent Rules")).toBe(true);

    const claudeContents = await readFile(
      join(context.cwd, "CLAUDE.md"),
      "utf8",
    );
    expect(claudeContents.includes("AGENTS.md")).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "master-prompt");
    expect(actionsAfterInstall.length).toBe(5);

    await masterPromptPlugin.uninstall(context);

    for (const [target, expectedContents] of initialContentsByTarget) {
      const restoredContents = await readFile(
        join(context.cwd, target),
        "utf8",
      );
      expect(restoredContents).toBe(expectedContents);
    }

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "master-prompt");
    expect(actionsAfterUninstall).toEqual([]);
  });
});
