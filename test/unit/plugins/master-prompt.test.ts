import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";

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
  };
}

async function planFor(context: Context): Promise<ProposedOperation[]> {
  return (await masterPromptPlugin.plan?.(context)) ?? [];
}

describe("master-prompt plugin — dedup-safe reconciliation", () => {
  it("inserts a delimited block into hand-written AGENTS.md and restores it on uninstall", async () => {
    const context = await createTestContext();
    const originalAgents = [
      "# House Rules",
      "",
      "1. Always run the linter before committing.",
      "2. Keep pull requests under 400 lines.",
      "3. Never force-push shared branches.",
      "",
    ].join("\n");
    await writeFile(join(context.cwd, "AGENTS.md"), originalAgents, "utf8");

    const plan = await planFor(context);
    const agentsOperation = plan.find(
      (operation) => operation.targetPath === "AGENTS.md",
    );
    expect(agentsOperation?.action).toBe("merge-block");

    await masterPromptPlugin.install(context);

    const merged = await readFile(join(context.cwd, "AGENTS.md"), "utf8");
    expect(merged).toContain(originalAgents.trimEnd());
    expect(merged).toContain("<!-- agemon:start:agent-rules -->");
    expect(merged).toContain("<!-- agemon:end:agent-rules -->");

    expect(await masterPromptPlugin.verify(context)).toMatchObject({
      ok: true,
    });
    expect(await planFor(context)).toEqual([]);

    await masterPromptPlugin.uninstall(context);

    expect(await readFile(join(context.cwd, "AGENTS.md"), "utf8")).toBe(
      originalAgents,
    );
  });

  it("creates AGENTS.md plus pointer files in a clean repo and reverses them", async () => {
    const context = await createTestContext();

    const plan = await planFor(context);
    expect(plan).toHaveLength(5);
    expect(plan.every((operation) => operation.action === "create")).toBe(true);

    await masterPromptPlugin.install(context);

    expect(await readFile(join(context.cwd, "AGENTS.md"), "utf8")).toContain(
      "<!-- agemon:start:agent-rules -->",
    );
    for (const pointer of ["CLAUDE.md", "GEMINI.md", ".cursorrules"]) {
      expect(await readFile(join(context.cwd, pointer), "utf8")).toContain(
        "AGENTS.md",
      );
    }

    expect(await masterPromptPlugin.verify(context)).toMatchObject({
      ok: true,
    });

    await masterPromptPlugin.uninstall(context);

    for (const target of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      await expect(
        readFile(join(context.cwd, target), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("adopts an existing pointer file without rewriting it", async () => {
    const context = await createTestContext();
    const handWrittenPointer =
      "# Claude\n\nSee AGENTS.md — that is the single source of truth.\n";
    await writeFile(join(context.cwd, "CLAUDE.md"), handWrittenPointer, "utf8");

    const claudeOperation = (await planFor(context)).find(
      (operation) => operation.targetPath === "CLAUDE.md",
    );
    expect(claudeOperation?.action).toBe("adopt");

    await masterPromptPlugin.install(context);

    expect(await readFile(join(context.cwd, "CLAUDE.md"), "utf8")).toBe(
      handWrittenPointer,
    );
    const adoption = context.manifest
      .getActions()
      .find((action) => action.target === "CLAUDE.md");
    expect(adoption?.ownershipMode).toBe("recorded-key");

    expect(await planFor(context)).toEqual([]);

    await masterPromptPlugin.uninstall(context);
    expect(await readFile(join(context.cwd, "CLAUDE.md"), "utf8")).toBe(
      handWrittenPointer,
    );
  });

  it("flags a pointer that carries independent rules as a conflict and never overwrites it", async () => {
    const context = await createTestContext();
    const independentRules =
      "# Claude Local Rules\n\n- Prefer short variable names.\n- Skip tests when changes look simple.\n";
    await writeFile(join(context.cwd, "CLAUDE.md"), independentRules, "utf8");

    const claudeOperation = (await planFor(context)).find(
      (operation) => operation.targetPath === "CLAUDE.md",
    );
    expect(claudeOperation?.action).toBe("conflict");

    await masterPromptPlugin.install(context);

    expect(await readFile(join(context.cwd, "CLAUDE.md"), "utf8")).toBe(
      independentRules,
    );
    expect(
      context.manifest
        .getActions()
        .some((action) => action.target === "CLAUDE.md"),
    ).toBe(false);
  });

  it("refreshes the ledger fingerprint after repairing a drifted managed block", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);

    const agentsPath = join(context.cwd, "AGENTS.md");
    const entryFor = () =>
      context.manifest
        .getActions()
        .find((action) => action.resourceId === "rule-file:AGENTS.md");
    const fingerprintAfterFirstInstall = entryFor()?.fingerprintAfter;

    await writeFile(
      agentsPath,
      "# Team heading kept by the user\n\n<!-- agemon:start:agent-rules -->\nmangled body\n<!-- agemon:end:agent-rules -->\n",
      "utf8",
    );

    await masterPromptPlugin.install(context);

    const repaired = await readFile(agentsPath, "utf8");
    expect(repaired).not.toContain("mangled body");
    expect(repaired).toContain("# Team heading kept by the user");
    const refreshed = entryFor()?.fingerprintAfter;
    expect(refreshed).not.toBe(fingerprintAfterFirstInstall);
    expect(refreshed).toBe(fingerprintContent(repaired));
    expect(await masterPromptPlugin.verify(context)).toMatchObject({
      ok: true,
    });
  });

  it("keeps the pristine backup when a managed AGENTS.md is edited and agemon re-runs", async () => {
    const context = await createTestContext();
    const originalAgents = "# Original hand-written rules\n\nKeep me.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), originalAgents, "utf8");

    await masterPromptPlugin.install(context);

    const backupPath = join(
      context.cwd,
      ".agemon/backups/rule-file_AGENTS.md.bak",
    );
    expect(await readFile(backupPath, "utf8")).toBe(originalAgents);

    await writeFile(
      join(context.cwd, "AGENTS.md"),
      "user tweaked the managed file\n",
      "utf8",
    );
    await masterPromptPlugin.install(context);

    expect(await readFile(backupPath, "utf8")).toBe(originalAgents);
  });
});
