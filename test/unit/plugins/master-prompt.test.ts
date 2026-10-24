import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../../src/core/apply.js";
import {
  resolveImmutableBackupPath,
  writeImmutableBackup,
} from "../../../src/core/backups.js";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";

const runningAsRoot = process.getuid?.() === 0;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await chmod(join(directoryPath, "CLAUDE.md"), 0o600).catch(() => undefined);
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

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

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

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

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

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});
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

    const backupPath = resolveImmutableBackupPath(
      context.cwd,
      "rule-file:AGENTS.md",
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

async function replaceWithPointer(
  context: Context,
  target: string,
): Promise<void> {
  const conflict = (await planFor(context)).find(
    (operation) => operation.targetPath === target,
  );
  if (!conflict) {
    throw new Error(`no planned operation for ${target}`);
  }
  await masterPromptPlugin.apply?.(context, [
    { ...conflict, action: "replace" },
  ]);
}

function recordedEntry(context: Context, target: string) {
  const entry = context.manifest
    .getActions()
    .find(
      (action) => action.plugin === "master-prompt" && action.target === target,
    );
  if (!entry) {
    throw new Error(`no ledger entry for ${target}`);
  }
  return entry;
}

function collectInfo(context: Context): string[] {
  const messages: string[] = [];
  context.ui = { ...context.ui, info: (message) => messages.push(message) };
  return messages;
}

async function readText(context: Context, target: string): Promise<string> {
  return readFile(join(context.cwd, target), "utf8");
}

const HAND_WRITTEN_RULES =
  "# Claude Local Rules\n\n- Prefer short variable names.\n- Skip tests when changes look simple.\n";

describe("master-prompt revert — never loses user content", () => {
  it("leaves exactly the pre-apply AGENTS.md after a rollback, even with an older backup on disk", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "AGENTS.md"), "current rules\n", "utf8");
    await writeImmutableBackup(
      context.cwd,
      "rule-file:AGENTS.md",
      "ancient rules from a long-gone run\n",
    );
    const masterPromptOperations = await planFor(context);
    const breakerOperation: ProposedOperation = {
      ...masterPromptOperations[0],
      id: "breaker:res:install",
      capabilityId: "breaker",
      resourceId: "res",
      targetPath: "res",
      action: "install-package",
      expectedFingerprint: null,
    };
    const breaker: AgemonPlugin = {
      id: "breaker",
      async detect() {
        return { present: false, preExisting: false };
      },
      async plan() {
        return [];
      },
      async install() {
        throw new Error("breaker exploded");
      },
      async verify() {
        return { ok: true };
      },
      async uninstall() {},
    };
    const operations = [...masterPromptOperations, breakerOperation];

    await expect(
      applyPlan(context, [masterPromptPlugin, breaker], {
        plan: {
          id: "0123456789abcdef",
          agemonVersion: "9.9.9",
          desiredStateHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
          operations,
        },
        approved: operations,
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/breaker exploded/);

    expect(await readText(context, "AGENTS.md")).toBe("current rules\n");
    await expect(readText(context, "CLAUDE.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores the user's current file, not a stale backup left by an earlier run", async () => {
    const context = await createTestContext();
    await writeImmutableBackup(
      context.cwd,
      "rule-file:CLAUDE.md",
      "stale pointer from an uninstalled run\n",
    );
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");

    await replaceWithPointer(context, "CLAUDE.md");
    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
  });

  it("keeps an AGENTS.md with broken markers and saves the original next to it", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "AGENTS.md"), "# House rules\n", "utf8");
    await masterPromptPlugin.install(context);
    const brokenMarkers = (await readText(context, "AGENTS.md")).replace(
      "<!-- agemon:end:agent-rules -->",
      "",
    );
    await writeFile(join(context.cwd, "AGENTS.md"), brokenMarkers, "utf8");
    const info = collectInfo(context);

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "AGENTS.md")).toBe(brokenMarkers);
    expect(await readText(context, "AGENTS.md.agemon-original")).toBe(
      "# House rules\n",
    );
    expect(context.manifest.hasActionForPlugin("master-prompt")).toBe(false);
    expect(info).toContainEqual(
      expect.stringMatching(
        /^manual cleanup needed: AGENTS\.md changed since agemon wrote it — kept as is; earlier contents saved as AGENTS\.md\.agemon-original$/,
      ),
    );
  });

  it("keeps a user-edited pointer that replaced pre-existing rules and saves the original", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    await writeFile(join(context.cwd, "CLAUDE.md"), "edited later\n", "utf8");

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe("edited later\n");
    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      HAND_WRITTEN_RULES,
    );
  });

  it("never deletes a created pointer the user has since edited", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);
    await writeFile(
      join(context.cwd, "GEMINI.md"),
      "my gemini notes\n",
      "utf8",
    );

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "GEMINI.md")).toBe("my gemini notes\n");
    await expect(
      readText(context, "GEMINI.md.agemon-original"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readText(context, "CLAUDE.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the user's text in a created AGENTS.md and removes only the block", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);
    const withUserText = `${await readText(context, "AGENTS.md")}\n## Mine\n\nkeep me\n`;
    await writeFile(join(context.cwd, "AGENTS.md"), withUserText, "utf8");

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    const remaining = await readText(context, "AGENTS.md");
    expect(remaining).toContain("## Mine");
    expect(remaining).not.toContain("agemon:start");
  });

  it("never overwrites an existing .agemon-original and keeps the original after .agemon is pruned", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    await writeFile(join(context.cwd, "CLAUDE.md"), "edited later\n", "utf8");
    await writeFile(
      join(context.cwd, "CLAUDE.md.agemon-original"),
      "from an earlier uninstall\n",
      "utf8",
    );

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});
    await context.manifest.pruneIfEmpty();

    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      "from an earlier uninstall\n",
    );
    const timestampedCopies = (await readdir(context.cwd)).filter((name) =>
      /^CLAUDE\.md\.agemon-original\.\d+$/.test(name),
    );
    expect(timestampedCopies).toHaveLength(1);
    expect(await readText(context, timestampedCopies[0])).toBe(
      HAND_WRITTEN_RULES,
    );
    await expect(readdir(join(context.cwd, ".agemon"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a v1-era file and copies its v1 backup out instead of restoring it", async () => {
    const context = await createTestContext();
    await mkdir(join(context.cwd, ".agemon/backups/master-prompt"), {
      recursive: true,
    });
    await writeFile(
      join(context.cwd, ".agemon/backups/master-prompt/CLAUDE.md.bak"),
      "original v1 rules\n",
      "utf8",
    );
    await writeFile(join(context.cwd, "CLAUDE.md"), "v1 pointer\n", "utf8");
    await writeFile(
      join(context.cwd, ".agemon/state.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        os: "linux",
        actions: [
          {
            id: "v1-entry",
            plugin: "master-prompt",
            type: "managed-rule-file",
            target: "CLAUDE.md",
            preExisting: true,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    context.manifest = await StateManifest.load(context.cwd);

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe("v1 pointer\n");
    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      "original v1 rules\n",
    );
  });

  it("falls back to the current backup name when the recorded path is gone", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const entry = recordedEntry(context, "CLAUDE.md");
    entry.backup = {
      path: join(context.cwd, ".agemon/backups/missing.bak"),
      checksum: entry.backup?.checksum ?? "",
    };

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
  });

  it("ignores a recorded backup path outside .agemon/backups and never touches it", async () => {
    const context = await createTestContext();
    const outside = await mkdtemp(join(tmpdir(), "agemon-outside-"));
    createdTempDirectories.push(outside);
    const foreignFile = join(outside, "not-a-backup.txt");
    await writeFile(foreignFile, "someone else's file\n", "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const entry = recordedEntry(context, "CLAUDE.md");
    entry.backup = { path: foreignFile, checksum: "irrelevant" };

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
    await expect(readFile(foreignFile, "utf8")).resolves.toBe(
      "someone else's file\n",
    );
  });

  it("reverts every other entry when one fails, then names the failure", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);
    await rm(join(context.cwd, "CLAUDE.md"));
    await mkdir(join(context.cwd, "CLAUDE.md"));

    await expect(
      uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {}),
    ).rejects.toThrow(/CLAUDE\.md/);

    await expect(readText(context, "GEMINI.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readText(context, "AGENTS.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps only the failed entry after a partial uninstall, so a retry is clean", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);
    await rm(join(context.cwd, "CLAUDE.md"));
    await mkdir(join(context.cwd, "CLAUDE.md"));

    await expect(masterPromptPlugin.uninstall(context)).rejects.toThrow(
      /CLAUDE\.md/,
    );

    expect(
      context.manifest
        .getActions()
        .filter((entry) => entry.plugin === "master-prompt")
        .map((entry) => entry.target),
    ).toEqual(["CLAUDE.md"]);

    await rm(join(context.cwd, "CLAUDE.md"), { recursive: true });
    const retryLines: string[] = [];
    await uninstallPlugins(
      {
        ...context,
        yes: true,
        ui: { ...context.ui, info: (line: string) => retryLines.push(line) },
      },
      [masterPromptPlugin],
      {},
    );

    expect(retryLines.filter((line) => /manual cleanup/i.test(line))).toEqual(
      [],
    );
  });

  it("restores from a legacy-named backup only after its checksum matches", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const entry = recordedEntry(context, "CLAUDE.md");
    entry.backup = null;
    await rename(
      resolveImmutableBackupPath(context.cwd, "rule-file:CLAUDE.md"),
      join(context.cwd, ".agemon/backups/rule-file_CLAUDE.md.bak"),
    );

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
  });

  it("skips a backup candidate that is a symlink and never copies it out", async () => {
    const context = await createTestContext();
    const outside = await mkdtemp(join(tmpdir(), "agemon-outside-"));
    createdTempDirectories.push(outside);
    await writeFile(join(outside, "id_rsa"), "private key\n", "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const pointerContents = await readText(context, "CLAUDE.md");
    recordedEntry(context, "CLAUDE.md").backup = null;
    await rm(resolveImmutableBackupPath(context.cwd, "rule-file:CLAUDE.md"));
    await symlink(
      join(outside, "id_rsa"),
      join(context.cwd, ".agemon/backups/rule-file_CLAUDE.md.bak"),
    );

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(pointerContents);
    const copies = (await readdir(context.cwd)).filter((name) =>
      name.includes("agemon-original"),
    );
    expect(copies).toEqual([]);
  });

  it("excises the block from an untouched AGENTS.md whose backup no longer matches", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "AGENTS.md"), "# House rules\n", "utf8");
    await masterPromptPlugin.install(context);
    await writeFile(
      resolveImmutableBackupPath(context.cwd, "rule-file:AGENTS.md"),
      "tampered backup\n",
      "utf8",
    );

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "AGENTS.md")).toBe("# House rules\n");
    await expect(
      readText(context, "AGENTS.md.agemon-original"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("master-prompt planning — symlinks and unreadable files", () => {
  it.skipIf(runningAsRoot)(
    "plans a symlinked CLAUDE.md as a conflict without reading its target",
    async () => {
      const context = await createTestContext();
      const outside = await mkdtemp(join(tmpdir(), "agemon-outside-"));
      createdTempDirectories.push(outside);
      const unreadableTarget = join(outside, "secret.md");
      await writeFile(unreadableTarget, "secret\n", "utf8");
      await chmod(unreadableTarget, 0o000);
      await symlink(unreadableTarget, join(context.cwd, "CLAUDE.md"));

      const claudeOperation = (await planFor(context)).find(
        (operation) => operation.targetPath === "CLAUDE.md",
      );

      await chmod(unreadableTarget, 0o600);
      expect(claudeOperation?.action).toBe("conflict");
      expect(claudeOperation?.preview.text).toMatch(/symlink, special file/);
    },
  );

  it.skipIf(runningAsRoot)(
    "fails planning on an unreadable CLAUDE.md instead of treating it as absent",
    async () => {
      const context = await createTestContext();
      const target = join(context.cwd, "CLAUDE.md");
      await writeFile(target, "root-owned rules\n", "utf8");
      await chmod(target, 0o000);

      await expect(planFor(context)).rejects.toMatchObject({ code: "EACCES" });

      await chmod(target, 0o600);
      expect(await readFile(target, "utf8")).toBe("root-owned rules\n");
    },
  );
});

describe("master-prompt — untrusted ledger, backups and oversized files", () => {
  it.each(["../x", "src/index.ts"])(
    "ignores a ledger entry for %j instead of reverting it",
    async (target) => {
      const context = await createTestContext();
      await mkdir(join(context.cwd, "src"));
      await writeFile(join(context.cwd, "src/index.ts"), "user code\n", "utf8");
      await context.manifest.recordAction({
        plugin: "master-prompt",
        type: "managed-rule-file",
        target,
        preExisting: false,
        resourceId: `rule-file:${target}`,
        ownershipMode: "created",
        fingerprintAfter: fingerprintContent("user code\n"),
      });
      const messages = collectInfo(context);

      await uninstallPlugins(
        { ...context, yes: true },
        [masterPromptPlugin],
        {},
      );

      expect(messages).toContain(
        `ignoring ledger entry for ${target}: master-prompt does not manage that file`,
      );
      expect(await readText(context, "src/index.ts")).toBe("user code\n");
      expect(context.manifest.getActions()).toEqual([]);
    },
  );

  it("keeps a differing v1 original while preserving the newer backup", async () => {
    const context = await createTestContext();
    const v1BackupPath = join(
      context.cwd,
      ".agemon/backups/master-prompt/CLAUDE.md.bak",
    );
    await mkdir(join(context.cwd, ".agemon/backups/master-prompt"), {
      recursive: true,
    });
    await writeFile(v1BackupPath, "original v1 rules\n", "utf8");
    await writeImmutableBackup(
      context.cwd,
      "rule-file:CLAUDE.md",
      "agemon's old pointer\n",
    );
    await writeFile(join(context.cwd, "CLAUDE.md"), "v1 pointer\n", "utf8");
    await context.manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "CLAUDE.md",
      preExisting: true,
    });

    await masterPromptPlugin.uninstall(context);

    expect(await readText(context, "CLAUDE.md")).toBe("v1 pointer\n");
    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      "agemon's old pointer\n",
    );
    await expect(readFile(v1BackupPath, "utf8")).resolves.toBe(
      "original v1 rules\n",
    );
  });

  it("removes an extra backup candidate that is byte-identical to the restored one", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const legacyBackupPath = join(
      context.cwd,
      ".agemon/backups/rule-file_CLAUDE.md.bak",
    );
    await writeFile(legacyBackupPath, HAND_WRITTEN_RULES, "utf8");

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
    await expect(readFile(legacyBackupPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails the entry and keeps it when .agemon/backups is a symlink", async () => {
    const context = await createTestContext();
    const outside = await mkdtemp(join(tmpdir(), "agemon-outside-"));
    createdTempDirectories.push(outside);
    await writeFile(join(outside, "rule-file_CLAUDE.md.bak"), "bait\n", "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const pointerContents = await readText(context, "CLAUDE.md");
    await rm(join(context.cwd, ".agemon/backups"), { recursive: true });
    await symlink(outside, join(context.cwd, ".agemon/backups"));

    await expect(
      uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {}),
    ).rejects.toThrow(/symlink or not a directory/);

    expect(await readText(context, "CLAUDE.md")).toBe(pointerContents);
    expect(recordedEntry(context, "CLAUDE.md")).toBeDefined();
    await expect(readdir(outside)).resolves.toEqual([
      "rule-file_CLAUDE.md.bak",
    ]);
  });

  it("plans an AGENTS.md larger than 8 MiB as a conflict", async () => {
    const context = await createTestContext();
    await writeFile(
      join(context.cwd, "AGENTS.md"),
      "x".repeat(8 * 1024 * 1024 + 1),
      "utf8",
    );

    const agentsOperation = (await planFor(context)).find(
      (operation) => operation.targetPath === "AGENTS.md",
    );

    expect(agentsOperation?.action).toBe("conflict");
    expect(agentsOperation?.preview.text).toMatch(/larger than 8 MiB/);
  });

  it("reports a symlinked managed AGENTS.md as a verification problem", async () => {
    const context = await createTestContext();
    await masterPromptPlugin.install(context);
    await rename(
      join(context.cwd, "AGENTS.md"),
      join(context.cwd, "AGENTS.real.md"),
    );
    await symlink(
      join(context.cwd, "AGENTS.real.md"),
      join(context.cwd, "AGENTS.md"),
    );

    const verification = await masterPromptPlugin.verify(context);

    expect(verification.ok).toBe(false);
    expect(verification.detail).toMatch(/AGENTS\.md.*not a regular file/);
  });
});

describe("master-prompt — backup candidates from an untrusted or older ledger", () => {
  it("never follows a recorded backup path through a symlinked subdirectory", async () => {
    const context = await createTestContext();
    const outside = await mkdtemp(join(tmpdir(), "agemon-outside-"));
    createdTempDirectories.push(outside);
    await mkdir(join(outside, "inner"));
    await writeFile(join(outside, "victim.bak"), "victim file\n", "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    await symlink(
      join(outside, "inner"),
      join(context.cwd, ".agemon/backups/sub"),
    );
    recordedEntry(context, "CLAUDE.md").backup = {
      path: `${context.cwd}/.agemon/backups/sub/../victim.bak`,
      checksum: "irrelevant",
    };
    await writeFile(join(context.cwd, "CLAUDE.md"), "edited pointer\n", "utf8");

    await uninstallPlugins({ ...context, yes: true }, [masterPromptPlugin], {});

    await expect(readFile(join(outside, "victim.bak"), "utf8")).resolves.toBe(
      "victim file\n",
    );
    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      HAND_WRITTEN_RULES,
    );
  });

  it("preserves the verified original rather than an unverified newer backup, and keeps both", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const legacyBackupPath = join(
      context.cwd,
      ".agemon/backups/rule-file_CLAUDE.md.bak",
    );
    await rename(
      resolveImmutableBackupPath(context.cwd, "rule-file:CLAUDE.md"),
      legacyBackupPath,
    );
    await writeImmutableBackup(
      context.cwd,
      "rule-file:CLAUDE.md",
      "agemon's old pointer\n",
    );
    recordedEntry(context, "CLAUDE.md").backup = {
      path: "/some/other/clone/.agemon/backups/rule-file_CLAUDE.md-x.bak",
      checksum: "irrelevant",
    };
    await writeFile(join(context.cwd, "CLAUDE.md"), "edited pointer\n", "utf8");

    await masterPromptPlugin.uninstall(context);

    expect(await readText(context, "CLAUDE.md")).toBe("edited pointer\n");
    expect(await readText(context, "CLAUDE.md.agemon-original")).toBe(
      HAND_WRITTEN_RULES,
    );
    await expect(
      readFile(
        resolveImmutableBackupPath(context.cwd, "rule-file:CLAUDE.md"),
        "utf8",
      ),
    ).resolves.toBe("agemon's old pointer\n");
  });
});

describe("master-prompt — never discards an unverified backup", () => {
  it("keeps an unverified backup when the file is already back to its original", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const backupPath = resolveImmutableBackupPath(
      context.cwd,
      "rule-file:CLAUDE.md",
    );
    await writeFile(backupPath, "the only copy of something else\n", "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");

    await masterPromptPlugin.uninstall(context);

    expect(await readText(context, "CLAUDE.md")).toBe(HAND_WRITTEN_RULES);
    await expect(readFile(backupPath, "utf8")).resolves.toBe(
      "the only copy of something else\n",
    );
  });

  it("never lets a forged entry resolve another resource's backup", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "CLAUDE.md"), HAND_WRITTEN_RULES, "utf8");
    await replaceWithPointer(context, "CLAUDE.md");
    const claudeBackupPath = resolveImmutableBackupPath(
      context.cwd,
      "rule-file:CLAUDE.md",
    );
    await writeFile(
      join(context.cwd, "AGENTS.md"),
      "# committed rules\n",
      "utf8",
    );
    await context.manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: true,
      resourceId: "rule-file:AGENTS.md",
      fingerprintBefore: fingerprintContent("# committed rules\n"),
      backup: { path: claudeBackupPath, checksum: "irrelevant" },
    });

    await masterPromptPlugin.revert?.(context, [
      recordedEntry(context, "AGENTS.md"),
    ]);

    await expect(readFile(claudeBackupPath, "utf8")).resolves.toBe(
      HAND_WRITTEN_RULES,
    );
  });
});
