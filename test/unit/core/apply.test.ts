import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../../src/core/apply.js";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";

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

async function createSandboxContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-apply-test-"));
  createdTempDirectories.push(sandboxDirectory);

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
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
  };
}

function operation(
  overrides: Partial<ProposedOperation> = {},
): ProposedOperation {
  return {
    id: "cap:res:create",
    capabilityId: "cap",
    resourceId: "res",
    targetPath: "res.txt",
    action: "create",
    riskClass: "writes-config",
    requiresConsent: true,
    expectedFingerprint: null,
    preview: { kind: "note", text: "" },
    ...overrides,
  };
}

function planWith(operations: ProposedOperation[]): Plan {
  return {
    id: "plan-under-test",
    agemonVersion: "9.9.9",
    desiredStateHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

interface FilePluginOptions {
  id: string;
  onInstall: (ctx: Context) => Promise<void>;
}

function createFilePlugin(options: FilePluginOptions): AgemonPlugin {
  return {
    id: options.id,
    async detect() {
      return { present: false, preExisting: false };
    },
    async plan() {
      return [];
    },
    async install(ctx) {
      await options.onInstall(ctx);
    },
    async verify() {
      return { ok: true };
    },
    async uninstall() {
      return;
    },
  };
}

describe("applyPlan workspace isolation", () => {
  it("refuses to write .agemon/ state when isolation is neither ignored nor approved", async () => {
    const ctx = await createSandboxContext();
    const op = operation();

    await expect(
      applyPlan(
        ctx,
        [createFilePlugin({ id: "cap", onInstall: async () => {} })],
        {
          plan: planWith([op]),
          approved: [op],
          workspaceIsolationApproved: false,
          isolationStatus: "not-ignored",
          allowUnignoredState: false,
        },
      ),
    ).rejects.toThrow(/not git-ignored/);

    await expect(
      readFile(join(ctx.cwd, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates .gitignore with /.agemon/ when the isolation gate was approved", async () => {
    const ctx = await createSandboxContext();
    const op = operation();

    await applyPlan(
      ctx,
      [createFilePlugin({ id: "cap", onInstall: async () => {} })],
      {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: true,
        isolationStatus: "no-gitignore-file",
        allowUnignoredState: false,
      },
    );

    await expect(
      readFile(join(ctx.cwd, ".gitignore"), "utf8"),
    ).resolves.toContain("/.agemon/");
  });

  it("proceeds without touching .gitignore under --allow-unignored-state", async () => {
    const ctx = await createSandboxContext();
    const op = operation();

    await applyPlan(
      ctx,
      [createFilePlugin({ id: "cap", onInstall: async () => {} })],
      {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "not-ignored",
        allowUnignoredState: true,
      },
    );

    await expect(
      readFile(join(ctx.cwd, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("applyPlan transaction protocol", () => {
  it("aborts before any write when a target drifted since planning", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "res.txt"), "user content\n", "utf8");
    const op = operation({
      action: "replace",
      expectedFingerprint: fingerprintContent("planned content\n"),
    });

    let installRan = false;
    await expect(
      applyPlan(
        ctx,
        [
          createFilePlugin({
            id: "cap",
            onInstall: async () => {
              installRan = true;
            },
          }),
        ],
        {
          plan: planWith([op]),
          approved: [op],
          workspaceIsolationApproved: null,
          isolationStatus: "ignored",
          allowUnignoredState: false,
        },
      ),
    ).rejects.toThrow(/stale/);

    expect(installRan).toBe(false);
    await expect(readFile(join(ctx.cwd, "res.txt"), "utf8")).resolves.toBe(
      "user content\n",
    );
  });

  it("rolls back a committed capability's file and ledger entries when a later one fails", async () => {
    const ctx = await createSandboxContext();
    const firstOp = operation({
      id: "first:a:create",
      capabilityId: "first",
      resourceId: "a",
      targetPath: "a.txt",
    });
    const secondOp = operation({
      id: "second:b:create",
      capabilityId: "second",
      resourceId: "b",
      targetPath: "b.txt",
    });

    const first = createFilePlugin({
      id: "first",
      onInstall: async (installCtx) => {
        await writeFile(
          join(installCtx.cwd, "a.txt"),
          "written by first\n",
          "utf8",
        );
        await installCtx.manifest.recordAction({
          plugin: "first",
          type: "created",
          target: "a.txt",
          preExisting: false,
        });
      },
    });
    const second: AgemonPlugin = {
      ...createFilePlugin({ id: "second", onInstall: async () => {} }),
      async install() {
        throw new Error("second capability blew up");
      },
    };

    await expect(
      applyPlan(ctx, [first, second], {
        plan: planWith([firstOp, secondOp]),
        approved: [firstOp, secondOp],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/blew up/);

    await expect(
      readFile(join(ctx.cwd, "a.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.manifest.getActions()).toEqual([]);
  });

  it("stages generated files under the plan directory and applies from the staged copy", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "create", targetPath: "AGENTS.md" });
    const stagedContents =
      "<!-- agemon:start:agent-rules -->\nbody\n<!-- agemon:end:agent-rules -->\n";

    const plugin: AgemonPlugin = {
      ...createFilePlugin({ id: "cap", onInstall: async () => {} }),
      async materialize() {
        return [
          {
            targetPath: "AGENTS.md",
            contents: stagedContents,
            kind: "markdown",
          },
        ];
      },
      async apply(applyCtx, _operations, staged) {
        await writeFile(
          join(applyCtx.cwd, "AGENTS.md"),
          staged?.[0]?.contents ?? "RE-RENDERED",
          "utf8",
        );
      },
    };

    await applyPlan(ctx, [plugin], {
      plan: planWith([op]),
      approved: [op],
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    });

    await expect(
      readFile(
        join(ctx.cwd, ".agemon/plans/plan-under-test/staged/AGENTS.md"),
        "utf8",
      ),
    ).resolves.toBe(stagedContents);
    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      stagedContents,
    );
  });

  it("aborts before any snapshot or write when a staged file is structurally invalid", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "create", targetPath: "config.json" });

    let installRan = false;
    const plugin: AgemonPlugin = {
      ...createFilePlugin({
        id: "cap",
        onInstall: async () => {
          installRan = true;
        },
      }),
      async materialize() {
        return [
          { targetPath: "config.json", contents: "{ not json", kind: "json" },
        ];
      },
    };

    await expect(
      applyPlan(ctx, [plugin], {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/config\.json/);

    expect(installRan).toBe(false);
    await expect(
      readFile(join(ctx.cwd, "config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(ctx.cwd, ".agemon/backups"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("calls a committed capability's revert when a later capability fails", async () => {
    const ctx = await createSandboxContext();
    const runCalls: { command: string; args: string[] }[] = [];
    ctx.run = async (command, args) => {
      runCalls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    };

    const installerOp = operation({
      id: "installer:pkg:install-package",
      capabilityId: "installer",
      resourceId: "pkg",
      targetPath: "pkg",
      action: "install-package",
    });
    const breakerOp = operation({
      id: "breaker:res:create",
      capabilityId: "breaker",
      resourceId: "res",
      targetPath: "res.txt",
    });

    let reverted: string[] = [];
    const installer: AgemonPlugin = {
      id: "installer",
      async detect() {
        return { present: false, preExisting: false };
      },
      async plan() {
        return [];
      },
      async apply(applyCtx) {
        await applyCtx.run("pipx", ["install", "code-review-graph"]);
        await applyCtx.manifest.recordAction({
          plugin: "installer",
          type: "installed-binary",
          target: "code-review-graph (pipx)",
          preExisting: false,
        });
      },
      async install() {},
      async verify() {
        return { ok: true };
      },
      async revert(revertCtx, entries) {
        reverted = entries.map((entry) => entry.type);
        if (entries.some((entry) => entry.type === "installed-binary")) {
          await revertCtx.run("pipx", ["uninstall", "code-review-graph"]);
        }
      },
      async uninstall() {},
    };
    const breaker: AgemonPlugin = {
      ...createFilePlugin({ id: "breaker", onInstall: async () => {} }),
      async install() {
        throw new Error("breaker exploded");
      },
    };

    await expect(
      applyPlan(ctx, [installer, breaker], {
        plan: planWith([installerOp, breakerOp]),
        approved: [installerOp, breakerOp],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/exploded/);

    expect(reverted).toEqual(["installed-binary"]);
    expect(runCalls).toContainEqual({
      command: "pipx",
      args: ["uninstall", "code-review-graph"],
    });
    expect(ctx.manifest.getActions()).toEqual([]);
  });

  it("reports manual cleanup when a capability's revert itself fails", async () => {
    const ctx = await createSandboxContext();
    const failures: string[] = [];
    ctx.ui = { ...ctx.ui, fail: (message: string) => failures.push(message) };

    const installerOp = operation({
      id: "installer:pkg:install-package",
      capabilityId: "installer",
      resourceId: "pkg",
      targetPath: "pkg",
      action: "install-package",
    });
    const breakerOp = operation({
      id: "breaker:res:create",
      capabilityId: "breaker",
      resourceId: "res",
      targetPath: "res.txt",
    });

    const installer: AgemonPlugin = {
      id: "installer",
      async detect() {
        return { present: false, preExisting: false };
      },
      async plan() {
        return [];
      },
      async apply(applyCtx) {
        await applyCtx.manifest.recordAction({
          plugin: "installer",
          type: "installed-binary",
          target: "pkg",
          preExisting: false,
        });
      },
      async install() {},
      async verify() {
        return { ok: true };
      },
      async revert() {
        throw new Error("pipx uninstall unavailable");
      },
      async uninstall() {},
    };
    const breaker: AgemonPlugin = {
      ...createFilePlugin({ id: "breaker", onInstall: async () => {} }),
      async install() {
        throw new Error("breaker exploded");
      },
    };

    await expect(
      applyPlan(ctx, [installer, breaker], {
        plan: planWith([installerOp, breakerOp]),
        approved: [installerOp, breakerOp],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/exploded/);

    expect(
      failures.some((message) =>
        /manual cleanup needed: installer: pipx uninstall unavailable/.test(
          message,
        ),
      ),
    ).toBe(true);
    expect(ctx.manifest.getActions()).toEqual([]);
  });

  it("returns the applied operations on success", async () => {
    const ctx = await createSandboxContext();
    const op = operation();

    const result = await applyPlan(
      ctx,
      [
        createFilePlugin({
          id: "cap",
          onInstall: async (installCtx) => {
            await writeFile(join(installCtx.cwd, "res.txt"), "done\n", "utf8");
          },
        }),
      ],
      {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      },
    );

    expect(result.applied).toEqual([op]);
    await expect(readFile(join(ctx.cwd, "res.txt"), "utf8")).resolves.toBe(
      "done\n",
    );
  });
});
