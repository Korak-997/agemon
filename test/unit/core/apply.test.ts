import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyRollbackError, applyPlan } from "../../../src/core/apply.js";
import { readJournals } from "../../../src/core/apply-journal.js";
import type { Context } from "../../../src/core/context.js";
import * as files from "../../../src/core/files.js";
import {
  fingerprintContent,
  sha256Hex,
} from "../../../src/core/fingerprint.js";
import { ApplyInterruptedError } from "../../../src/core/interruption.js";
import { buildPlan } from "../../../src/core/orchestrator.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

vi.mock("../../../src/core/files.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/files.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

const runningAsRoot = process.getuid?.() === 0;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.mocked(files.writeFileAtomic).mockReset();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

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

async function createSandboxContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-apply-test-"));
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    log: console,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
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

const PLAN_ID = "0123456789abcdef";

function planWith(operations: ProposedOperation[]): Plan {
  return {
    id: PLAN_ID,
    agemonVersion: "9.9.9",
    desiredStateHash: "hash",
    inputs: { capabilityIds: [], skillGroups: null },
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

  it("appends /.agemon/ after an approval even when a negated .agemon line exists", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, ".gitignore"), ".agemon\n!.agemon\n", "utf8");
    const op = operation();

    await applyPlan(
      ctx,
      [createFilePlugin({ id: "cap", onInstall: async () => {} })],
      {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: true,
        isolationStatus: "not-ignored",
        allowUnignoredState: false,
      },
    );

    await expect(readFile(join(ctx.cwd, ".gitignore"), "utf8")).resolves.toBe(
      ".agemon\n!.agemon\n/.agemon/\n",
    );
  });

  it("prints a failing tool's escape sequences as ? in the rollback line", async () => {
    const ctx = await createSandboxContext();
    const failed: string[] = [];
    ctx.ui = {
      ...ctx.ui,
      fail(label) {
        failed.push(label ?? "");
      },
    };
    const op = operation();
    const escapeCharacter = String.fromCharCode(27);

    await expect(
      applyPlan(
        ctx,
        [
          createFilePlugin({
            id: "cap",
            onInstall: async () => {
              throw new Error(
                `pip said ${escapeCharacter}]0;pwned${String.fromCharCode(7)}`,
              );
            },
          }),
        ],
        { plan: planWith([op]), approved: [op], ...IGNORED_ISOLATION },
      ),
    ).rejects.toBeInstanceOf(ApplyRollbackError);

    expect(failed.join("\n")).toContain("pip said ?]0;pwned?");
    expect(failed.join("\n")).not.toContain(escapeCharacter);
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

    const first = stagingWriter("first", "a.txt", "written by first\n");
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
        join(
          ctx.cwd,
          ".agemon/plans",
          PLAN_ID,
          "staged",
          sha256Hex("AGENTS.md").slice(0, 16),
        ),
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

  it("reports manual cleanup when a capability's revert itself fails, and keeps its entries for a retry", async () => {
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
        throw new Error(
          `pipx uninstall unavailable ${String.fromCharCode(27)}]0;title`,
        );
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
        /manual cleanup needed: installer: pipx uninstall unavailable \?\]0;title/.test(
          message,
        ),
      ),
    ).toBe(true);
    expect(failures.join("\n")).not.toContain(String.fromCharCode(27));
    expect(ctx.manifest.getActions().map((entry) => entry.target)).toEqual([
      "pkg",
    ]);
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

  it("a capability with neither apply nor install fails clearly", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "install-package", targetPath: "pkg" });
    const { install: _install, ...pluginWithoutWork } = createFilePlugin({
      id: "cap",
      onInstall: async () => {},
    });

    const error = await captureRollbackError(
      applyPlan(ctx, [pluginWithoutWork], {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    );

    expect(error.message).toContain(
      "Capability 'cap' has neither apply nor install.",
    );
  });

  it("plugins whose apply returns nothing still count every operation", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "install-package", targetPath: "pkg" });

    const result = await applyPlan(
      ctx,
      [
        {
          ...createFilePlugin({ id: "cap", onInstall: async () => {} }),
          async apply() {
            return undefined;
          },
        },
      ],
      {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      },
    );

    expect(result).toEqual({ applied: [op], skipped: [] });
  });

  it("applies a capability whose verify passes with an attention note, printing it and rolling nothing back", async () => {
    const ctx = await createSandboxContext();
    const infos: string[] = [];
    ctx.ui = { ...ctx.ui, info: (message: string) => infos.push(message) };
    const op = operation();

    const result = await applyPlan(
      ctx,
      [
        {
          ...createFilePlugin({
            id: "cap",
            onInstall: async (installCtx) => {
              await writeFile(
                join(installCtx.cwd, "res.txt"),
                "done\n",
                "utf8",
              );
            },
          }),
          async verify() {
            return { ok: true, attention: "agnix is not the pinned build" };
          },
        },
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
    expect(infos).toContain("cap: agnix is not the pinned build");
    await expect(readFile(join(ctx.cwd, "res.txt"), "utf8")).resolves.toBe(
      "done\n",
    );
  });
});

async function captureRollbackError(
  pending: Promise<unknown>,
): Promise<ApplyRollbackError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ApplyRollbackError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected applyPlan to roll back");
}

function failingPlugin(id: string, message: string): AgemonPlugin {
  return {
    ...createFilePlugin({ id, onInstall: async () => {} }),
    async install() {
      throw new Error(message);
    },
  };
}

function replaceOperation(
  capabilityId: string,
  targetPath: string,
  currentContents: string,
): ProposedOperation {
  return operation({
    id: `${capabilityId}:${targetPath}:replace`,
    capabilityId,
    resourceId: `file:${targetPath}`,
    targetPath,
    action: "replace",
    expectedFingerprint: fingerprintContent(currentContents),
  });
}

describe("applyPlan rollback hardening", () => {
  it.skipIf(runningAsRoot)(
    "fails before any user-file write when a target cannot be read, and keeps the file",
    async () => {
      const ctx = await createSandboxContext();
      const target = join(ctx.cwd, "CLAUDE.md");
      await writeFile(target, "root-owned rules\n", "utf8");
      await chmod(target, 0o000);
      const op = replaceOperation("cap", "CLAUDE.md", "root-owned rules\n");

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
      ).rejects.toMatchObject({ code: "EACCES" });

      expect(installRan).toBe(false);
      expect((await stat(target)).mode & 0o7777).toBe(0o000);
      await chmod(target, 0o600);
      await expect(readFile(target, "utf8")).resolves.toBe(
        "root-owned rules\n",
      );
    },
  );

  it("keeps restoring and reverting when one snapshot restore fails, and reports the original error", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    await writeFile(join(ctx.cwd, "b.txt"), "original b\n", "utf8");
    const writerOps = [
      replaceOperation("writer", "a.txt", "original a\n"),
      replaceOperation("writer", "b.txt", "original b\n"),
    ];
    const breakerOp = operation({
      id: "breaker:pkg:install-package",
      capabilityId: "breaker",
      resourceId: "pkg",
      targetPath: "pkg",
      action: "install-package",
    });

    let writerReverted = false;
    const writer: AgemonPlugin = {
      ...createFilePlugin({ id: "writer", onInstall: async () => {} }),
      async materialize() {
        return [
          { targetPath: "a.txt", contents: "new a\n", kind: "text" },
          { targetPath: "b.txt", contents: "new b\n", kind: "text" },
        ];
      },
      async apply(applyCtx, _operations, staged) {
        for (const file of staged ?? []) {
          await writeFile(join(applyCtx.cwd, file.targetPath), file.contents);
        }
        await applyCtx.manifest.recordAction({
          plugin: "writer",
          type: "installed-binary",
          target: "pkg",
          preExisting: false,
        });
      },
      async revert() {
        writerReverted = true;
      },
    };
    const restoreFailure = new Error("disk went away");
    vi.mocked(files.writeFileAtomic).mockImplementation(
      async (path, contents) => {
        if (path === join(ctx.cwd, "a.txt")) {
          throw restoreFailure;
        }
        const actual = await vi.importActual<
          typeof import("../../../src/core/files.js")
        >("../../../src/core/files.js");
        await actual.writeFileAtomic(path, contents);
      },
    );

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [writer, failingPlugin("breaker", "breaker exploded")], {
        plan: planWith([...writerOps, breakerOp]),
        approved: [...writerOps, breakerOp],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    );

    expect(rollbackError.message).toBe("breaker exploded");
    expect((rollbackError.cause as Error).message).toBe("breaker exploded");
    await expect(readFile(join(ctx.cwd, "b.txt"), "utf8")).resolves.toBe(
      "original b\n",
    );
    expect(rollbackError.rollback.restored).toEqual(["restored b.txt"]);
    expect(rollbackError.rollback.manualCleanup).toEqual([
      expect.stringMatching(
        /^a\.txt: could not restore its pre-apply contents \(disk went away\); run 'agemon recover' to retry\.$/,
      ),
    ]);
    expect(writerReverted).toBe(true);
    expect(ctx.manifest.getActions()).toEqual([]);
  });

  it("reverts the capability that threw, with only its own new entries", async () => {
    const ctx = await createSandboxContext();
    await ctx.manifest.recordAction({
      plugin: "flaky",
      type: "registered-service",
      target: "from an earlier run",
      preExisting: false,
    });
    const op = operation({
      id: "flaky:unit:install",
      capabilityId: "flaky",
      resourceId: "unit",
      targetPath: "unit",
      action: "install-package",
    });

    let revertedTargets: string[] | null = null;
    const flaky: AgemonPlugin = {
      ...createFilePlugin({
        id: "flaky",
        onInstall: async (installCtx) => {
          await installCtx.manifest.recordAction({
            plugin: "flaky",
            type: "registered-service",
            target: "agemon-crg.service",
            preExisting: false,
          });
          throw new Error("verify of the new unit failed");
        },
      }),
      async revert(_revertCtx, entries) {
        revertedTargets = entries.map((entry) => entry.target);
      },
    };

    await expect(
      applyPlan(ctx, [flaky], {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/verify of the new unit failed/);

    expect(revertedTargets).toEqual(["agemon-crg.service"]);
    expect(ctx.manifest.getActions().map((entry) => entry.target)).toEqual([
      "from an earlier run",
    ]);
  });

  it("reports a ledger cleanup failure as manual cleanup instead of masking the error", async () => {
    const ctx = await createSandboxContext();
    ctx.manifest.restoreActions = async () => {
      throw new Error("state.json is read-only");
    };
    const op = operation();

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [failingPlugin("cap", "install failed")], {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    );

    expect(rollbackError.message).toBe("install failed");
    expect(rollbackError.rollback.manualCleanup).toContain(
      "ledger: state.json is read-only",
    );
  });

  it("captures snapshots without writing any backup", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const op = replaceOperation("cap", "a.txt", "original a\n");

    await expect(
      applyPlan(ctx, [failingPlugin("cap", "install failed")], {
        plan: planWith([op]),
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/install failed/);

    await expect(readFile(join(ctx.cwd, "a.txt"), "utf8")).resolves.toBe(
      "original a\n",
    );
    await expect(
      readdir(join(ctx.cwd, ".agemon/backups")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const IGNORED_ISOLATION = {
  workspaceIsolationApproved: null,
  isolationStatus: "ignored",
  allowUnignoredState: false,
} as const;

async function createOutsideDirectory(): Promise<string> {
  const outside = await mkdtemp(join(tmpdir(), "agemon-apply-outside-"));
  createdTempDirectories.push(outside);
  await writeFile(join(outside, "x"), "outside\n", "utf8");
  return outside;
}

async function expectOutsideUnchanged(outside: string): Promise<void> {
  await expect(readdir(outside)).resolves.toEqual(["x"]);
  await expect(readFile(join(outside, "x"), "utf8")).resolves.toBe("outside\n");
}

describe("applyPlan path confinement", () => {
  it.each(["../outside", "/etc/x", ".git/config"])(
    "refuses the plan target %j before running any capability",
    async (targetPath) => {
      const ctx = await createSandboxContext();
      const op = operation({ action: "replace", targetPath });
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
          { plan: planWith([op]), approved: [op], ...IGNORED_ISOLATION },
        ),
      ).rejects.toThrow(/agemon only touches files inside the repository/);

      expect(installRan).toBe(false);
    },
  );

  it("refuses a target under a symlinked parent and writes nothing outside", async () => {
    const ctx = await createSandboxContext();
    const outside = await createOutsideDirectory();
    await symlink(outside, join(ctx.cwd, "docs"));
    const op = operation({ action: "create", targetPath: "docs/new.md" });

    await expect(
      applyPlan(
        ctx,
        [
          createFilePlugin({
            id: "cap",
            onInstall: async (installCtx) => {
              await writeFile(join(installCtx.cwd, "docs/new.md"), "x", "utf8");
            },
          }),
        ],
        { plan: planWith([op]), approved: [op], ...IGNORED_ISOLATION },
      ),
    ).rejects.toThrow(/symlink or not a directory/);

    await expectOutsideUnchanged(outside);
  });

  it.each([
    ["a non-file action", "skip"],
    ["a file action", "create"],
  ] as const)(
    "refuses a forged master-prompt operation with %s on src/index.ts",
    async (_label, action) => {
      const ctx = await createSandboxContext();
      await mkdir(join(ctx.cwd, "src"));
      await writeFile(join(ctx.cwd, "src/index.ts"), "user code\n", "utf8");
      const op = operation({
        id: `master-prompt:rule-file:src/index.ts:${action}`,
        capabilityId: "master-prompt",
        resourceId: "rule-file:src/index.ts",
        targetPath: "src/index.ts",
        action,
        expectedFingerprint: fingerprintContent("user code\n"),
      });

      await expect(
        applyPlan(ctx, [masterPromptPlugin], {
          plan: planWith([op]),
          approved: [op],
          ...IGNORED_ISOLATION,
        }),
      ).rejects.toThrow(/is not something master-prompt does/);

      await expect(
        readFile(join(ctx.cwd, "src/index.ts"), "utf8"),
      ).resolves.toBe("user code\n");
      expect(ctx.manifest.getActions()).toEqual([]);
    },
  );

  it("detects a stale plan before .gitignore or the plan file is written", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "res.txt"), "user content\n", "utf8");
    const op = operation({
      action: "replace",
      expectedFingerprint: fingerprintContent("planned content\n"),
    });

    await expect(
      applyPlan(
        ctx,
        [createFilePlugin({ id: "cap", onInstall: async () => {} })],
        {
          plan: planWith([op]),
          approved: [op],
          workspaceIsolationApproved: true,
          isolationStatus: "no-gitignore-file",
          allowUnignoredState: false,
        },
      ),
    ).rejects.toThrow(/stale/);

    await expect(readdir(ctx.cwd)).resolves.toEqual(["res.txt"]);
  });

  it("stages a target whose encoded name would exceed 255 bytes, with a manifest", async () => {
    const ctx = await createSandboxContext();
    const targetPath = `${"a/".repeat(100)}x.md`;
    const op = operation({ action: "create", targetPath });
    const plugin: AgemonPlugin = {
      ...createFilePlugin({ id: "cap", onInstall: async () => {} }),
      async materialize() {
        return [{ targetPath, contents: "staged\n", kind: "text" }];
      },
      async apply() {},
    };

    await applyPlan(ctx, [plugin], {
      plan: planWith([op]),
      approved: [op],
      ...IGNORED_ISOLATION,
    });

    const stagedDirectory = join(ctx.cwd, ".agemon/plans", PLAN_ID, "staged");
    const stagedName = sha256Hex(targetPath).slice(0, 16);
    await expect(
      readFile(join(stagedDirectory, stagedName), "utf8"),
    ).resolves.toBe("staged\n");
    expect(
      JSON.parse(
        await readFile(join(stagedDirectory, "manifest.json"), "utf8"),
      ),
    ).toEqual({ [stagedName]: targetPath });
  });
});

describe("applyPlan with a symlinked .agemon/ component", () => {
  it.each([".agemon", ".agemon/plans"])(
    "fails before writing when %s is a symlink",
    async (linkedPath) => {
      const ctx = await createSandboxContext();
      const outside = await createOutsideDirectory();
      await mkdir(join(ctx.cwd, linkedPath, ".."), { recursive: true });
      await symlink(outside, join(ctx.cwd, linkedPath));
      const op = operation();
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
          { plan: planWith([op]), approved: [op], ...IGNORED_ISOLATION },
        ),
      ).rejects.toThrow(/symlink or not a directory/);

      expect(installRan).toBe(false);
      await expectOutsideUnchanged(outside);
    },
  );

  it("rolls back when master-prompt's backup directory is a symlink", async () => {
    const ctx = await createSandboxContext();
    const outside = await createOutsideDirectory();
    await writeFile(join(ctx.cwd, "AGENTS.md"), "# Our rules\n", "utf8");
    await mkdir(join(ctx.cwd, ".agemon"), { recursive: true });
    await symlink(outside, join(ctx.cwd, ".agemon/backups"));
    const operations = (await masterPromptPlugin.plan?.(ctx)) ?? [];
    const mergeOperation = operations.filter(
      (candidate) => candidate.targetPath === "AGENTS.md",
    );

    await expect(
      applyPlan(ctx, [masterPromptPlugin], {
        plan: planWith(mergeOperation),
        approved: mergeOperation,
        ...IGNORED_ISOLATION,
      }),
    ).rejects.toThrow(/symlink or not a directory/);

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Our rules\n",
    );
    await expectOutsideUnchanged(outside);
  });
});

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalListenerCounts(): number[] {
  return INTERRUPT_SIGNALS.map((signal) => process.listenerCount(signal));
}

function stagingWriter(
  id: string,
  targetPath: string,
  stagedContents: string,
  afterWrite: (ctx: Context) => Promise<void> = async () => {},
): AgemonPlugin {
  return {
    ...createFilePlugin({ id, onInstall: async () => {} }),
    async materialize() {
      return [{ targetPath, contents: stagedContents, kind: "text" }];
    },
    async apply(applyCtx, _operations, staged) {
      for (const file of staged ?? []) {
        await writeFile(join(applyCtx.cwd, file.targetPath), file.contents);
      }
      await applyCtx.manifest.recordAction({
        plugin: id,
        type: "managed-rule-file",
        target: targetPath,
        preExisting: true,
      });
      await afterWrite(applyCtx);
    },
  };
}

describe("applyPlan interruption journal", () => {
  it("keeps a journal outside the repo while a capability runs, and deletes it on success", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const op = replaceOperation("writer", "a.txt", "original a\n");
    let journalsDuringRun: Awaited<ReturnType<typeof readJournals>> = [];
    const writer = stagingWriter("writer", "a.txt", "new a\n", async () => {
      journalsDuringRun = await readJournals(ctx.cwd);
    });

    await applyPlan(ctx, [writer], {
      plan: planWith([op]),
      approved: [op],
      ...IGNORED_ISOLATION,
    });

    expect(journalsDuringRun).toHaveLength(1);
    const [{ path, journal }] = journalsDuringRun;
    expect(path.startsWith(ctx.cwd)).toBe(false);
    expect(journal).toMatchObject({
      planId: PLAN_ID,
      capabilityOrder: ["writer"],
      ledgerBefore: [],
      snapshots: [
        {
          targetPath: "a.txt",
          previousContents: "original a\n",
          stagedFingerprint: fingerprintContent("new a\n"),
        },
      ],
    });
    await expect(
      stat(join(ctx.cwd, ".agemon/plans", PLAN_ID, "journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("deletes the journal after a clean rollback", async () => {
    const ctx = await createSandboxContext();
    const op = operation();

    await expect(
      applyPlan(ctx, [failingPlugin("cap", "install failed")], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    ).rejects.toThrow(/install failed/);

    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("keeps the journal when a restore fails", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const op = replaceOperation("writer", "a.txt", "original a\n");
    const writer = stagingWriter("writer", "a.txt", "new a\n", async () => {
      throw new Error("writer exploded");
    });
    const actualFiles = await vi.importActual<
      typeof import("../../../src/core/files.js")
    >("../../../src/core/files.js");
    vi.mocked(files.writeFileAtomic).mockImplementation(
      async (path, contents, options) => {
        if (path === join(ctx.cwd, "a.txt")) {
          throw new Error("disk went away");
        }
        await actualFiles.writeFileAtomic(path, contents, options);
      },
    );

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [writer], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    );

    expect(rollbackError.rollback.manualCleanup).toEqual([
      "a.txt: could not restore its pre-apply contents (disk went away); run 'agemon recover' to retry.",
    ]);
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it("keeps the journal when a plugin revert fails", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "install-package", targetPath: "pkg" });
    const plugin: AgemonPlugin = {
      ...createFilePlugin({
        id: "cap",
        onInstall: async (installCtx) => {
          await installCtx.manifest.recordAction({
            plugin: "cap",
            type: "installed-binary",
            target: "pkg",
            preExisting: false,
          });
          throw new Error("install failed");
        },
      }),
      async revert() {
        throw new Error("uninstall failed");
      },
    };

    await expect(
      applyPlan(ctx, [plugin], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    ).rejects.toThrow(/install failed/);

    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it("keeps the journal when the ledger restore fails", async () => {
    const ctx = await createSandboxContext();
    ctx.manifest.restoreActions = async () => {
      throw new Error("state.json is read-only");
    };
    const op = operation();

    await expect(
      applyPlan(ctx, [failingPlugin("cap", "install failed")], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    ).rejects.toThrow(/install failed/);

    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it("restores a ledger entry that the failed run edited in place", async () => {
    const ctx = await createSandboxContext();
    await ctx.manifest.recordAction({
      plugin: "cap",
      type: "managed-rule-file",
      target: "a.txt",
      preExisting: false,
      resourceId: "res",
      fingerprintAfter: "before-run",
    });
    const op = operation();
    const plugin = createFilePlugin({
      id: "cap",
      onInstall: async (installCtx) => {
        await installCtx.manifest.updateResourceEntry("res", {
          fingerprintAfter: "during-run",
        });
        throw new Error("install failed");
      },
    });

    await expect(
      applyPlan(ctx, [plugin], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    ).rejects.toThrow(/install failed/);

    expect(ctx.manifest.getActions()[0]?.fingerprintAfter).toBe("before-run");
    const reloaded = await StateManifest.load(ctx.cwd);
    expect(reloaded.getActions()[0]?.fingerprintAfter).toBe("before-run");
  });

  it("refuses an oversized journal before any planned target is written", async () => {
    const ctx = await createSandboxContext();
    const baseline = signalListenerCounts();
    const halfCap = "x".repeat(files.MAX_READ_FILE_BYTES / 2 + 1);
    await writeFile(join(ctx.cwd, "a.md"), halfCap, "utf8");
    await writeFile(join(ctx.cwd, "b.md"), halfCap, "utf8");
    const ops = [
      replaceOperation("writer", "a.md", halfCap),
      replaceOperation("writer", "b.md", halfCap),
    ];
    let installRan = false;

    await expect(
      applyPlan(
        ctx,
        [
          createFilePlugin({
            id: "writer",
            onInstall: async () => {
              installRan = true;
            },
          }),
        ],
        { plan: planWith(ops), approved: ops, ...IGNORED_ISOLATION },
      ),
    ).rejects.toThrow(/rollback journal would exceed 8 MiB \(2 rule files\)/);

    expect(installRan).toBe(false);
    await expect(readFile(join(ctx.cwd, "a.md"), "utf8")).resolves.toBe(
      halfCap,
    );
    expect(signalListenerCounts()).toEqual(baseline);
  });

  it("records the plan id on new entries during the run only", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "install-package", targetPath: "pkg" });
    const plugin = createFilePlugin({
      id: "cap",
      onInstall: async (installCtx) => {
        await installCtx.manifest.recordAction({
          plugin: "cap",
          type: "installed-binary",
          target: "during",
          preExisting: false,
        });
      },
    });

    await applyPlan(ctx, [plugin], {
      plan: planWith([op]),
      approved: [op],
      ...IGNORED_ISOLATION,
    });
    const after = await ctx.manifest.recordAction({
      plugin: "cap",
      type: "installed-binary",
      target: "after",
      preExisting: false,
    });

    expect(ctx.manifest.getActions()[0]).toMatchObject({
      target: "during",
      planId: PLAN_ID,
      agemonVersion: "9.9.9",
    });
    expect(after).toMatchObject({ planId: null, agemonVersion: null });
  });
});

describe("applyPlan signal handling", () => {
  it("rolls back and reports the signal when a step rejects after SIGINT, keeping the step error", async () => {
    const ctx = await createSandboxContext();
    const baseline = signalListenerCounts();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const op = replaceOperation("writer", "a.txt", "original a\n");
    const writer = stagingWriter("writer", "a.txt", "new a\n", async () => {
      process.emit("SIGINT", "SIGINT");
      throw new Error("npm exited with signal SIGINT");
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [writer], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    );

    expect(rollbackError.cause).toBeInstanceOf(ApplyInterruptedError);
    expect((rollbackError.cause as ApplyInterruptedError).signal).toBe(
      "SIGINT",
    );
    expect((rollbackError.cause as ApplyInterruptedError).exitCode).toBe(130);
    expect(rollbackError.message).toBe(
      "interrupted by SIGINT (npm exited with signal SIGINT)",
    );
    await expect(readFile(join(ctx.cwd, "a.txt"), "utf8")).resolves.toBe(
      "original a\n",
    );
    expect(ctx.manifest.getActions()).toEqual([]);
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
    expect(signalListenerCounts()).toEqual(baseline);
  });

  it("stops before the next capability when the step resolves after SIGTERM", async () => {
    const ctx = await createSandboxContext();
    const baseline = signalListenerCounts();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const writerOp = replaceOperation("writer", "a.txt", "original a\n");
    const laterOp = operation({
      id: "later:res:create",
      capabilityId: "later",
    });
    let laterRan = false;
    const writer = stagingWriter("writer", "a.txt", "new a\n", async () => {
      process.emit("SIGTERM", "SIGTERM");
    });
    const later = createFilePlugin({
      id: "later",
      onInstall: async () => {
        laterRan = true;
      },
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [writer, later], {
        plan: planWith([writerOp, laterOp]),
        approved: [writerOp, laterOp],
        ...IGNORED_ISOLATION,
      }),
    );

    expect(laterRan).toBe(false);
    expect(rollbackError.message).toBe("interrupted by SIGTERM");
    expect((rollbackError.cause as ApplyInterruptedError).exitCode).toBe(143);
    await expect(readFile(join(ctx.cwd, "a.txt"), "utf8")).resolves.toBe(
      "original a\n",
    );
    expect(signalListenerCounts()).toEqual(baseline);
  });

  it("checks for a signal after the last capability", async () => {
    const ctx = await createSandboxContext();
    const op = operation({ action: "install-package", targetPath: "pkg" });
    const plugin = createFilePlugin({
      id: "cap",
      onInstall: async () => {
        process.emit("SIGHUP", "SIGHUP");
      },
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [plugin], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    );

    expect((rollbackError.cause as ApplyInterruptedError).exitCode).toBe(129);
  });

  it("exits at once through the injected exitProcess on a second signal", async () => {
    const ctx = await createSandboxContext();
    const exitCodes: number[] = [];
    const op = operation({ action: "install-package", targetPath: "pkg" });
    const plugin = createFilePlugin({
      id: "cap",
      onInstall: async () => {
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
      },
    });

    await expect(
      applyPlan(ctx, [plugin], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
        exitProcess: (code) => {
          exitCodes.push(code);
        },
      }),
    ).rejects.toBeInstanceOf(ApplyRollbackError);

    expect(exitCodes).toEqual([130]);
  });

  it("still rolls back when the terminal is gone and printing fails", async () => {
    const ctx = await createSandboxContext();
    ctx.ui = {
      ...ctx.ui,
      fail() {
        throw Object.assign(new Error("write EIO"), { code: "EIO" });
      },
    };
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const op = replaceOperation("writer", "a.txt", "original a\n");
    const writer = stagingWriter("writer", "a.txt", "new a\n", async () => {
      process.emit("SIGHUP", "SIGHUP");
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [writer], {
        plan: planWith([op]),
        approved: [op],
        ...IGNORED_ISOLATION,
      }),
    );

    expect((rollbackError.cause as ApplyInterruptedError).exitCode).toBe(129);
    await expect(readFile(join(ctx.cwd, "a.txt"), "utf8")).resolves.toBe(
      "original a\n",
    );
  });

  it("keeps a file edited during the apply, saves its original beside it and keeps the journal", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "a.txt"), "original a\n", "utf8");
    const slowOp = operation({
      id: "slow:pkg:install",
      capabilityId: "slow",
      resourceId: "pkg",
      targetPath: "pkg",
      action: "install-package",
    });
    const writerOp = replaceOperation("writer", "a.txt", "original a\n");
    const slow = createFilePlugin({
      id: "slow",
      onInstall: async (installCtx) => {
        await writeFile(join(installCtx.cwd, "a.txt"), "user edit\n", "utf8");
        throw new Error("npm install failed");
      },
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [slow, stagingWriter("writer", "a.txt", "new a\n")], {
        plan: planWith([slowOp, writerOp]),
        approved: [slowOp, writerOp],
        ...IGNORED_ISOLATION,
      }),
    );

    await expect(readFile(join(ctx.cwd, "a.txt"), "utf8")).resolves.toBe(
      "user edit\n",
    );
    await expect(
      readFile(join(ctx.cwd, "a.txt.agemon-original"), "utf8"),
    ).resolves.toBe("original a\n");
    expect(rollbackError.rollback.manualCleanup).toEqual([
      "a.txt: changed since the apply started — kept as is; its pre-apply contents are saved as a.txt.agemon-original",
    ]);
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it.skipIf(runningAsRoot)(
    "still reports success when the journal cannot be deleted afterwards, and names it",
    async () => {
      const ctx = await createSandboxContext();
      const failures: string[] = [];
      ctx.ui = { ...ctx.ui, fail: (message: string) => failures.push(message) };
      const op = operation({ action: "install-package", targetPath: "pkg" });
      let journalDirectory = "";
      const plugin = createFilePlugin({
        id: "cap",
        onInstall: async () => {
          const [{ path }] = await readJournals(ctx.cwd);
          journalDirectory = join(path, "..");
          await chmod(journalDirectory, 0o500);
        },
      });

      try {
        await expect(
          applyPlan(ctx, [plugin], {
            plan: planWith([op]),
            approved: [op],
            ...IGNORED_ISOLATION,
          }),
        ).resolves.toEqual({ applied: [op], skipped: [] });
      } finally {
        await chmod(journalDirectory, 0o700);
      }

      expect(failures).toEqual([
        expect.stringMatching(
          /^Applied, but could not delete the rollback journal .*0123456789abcdef\.json .*do not run 'agemon recover'/,
        ),
      ]);
    },
  );
});

describe("applyPlan in-process rollback with the real master-prompt plugin", () => {
  it("keeps the ledger entry of a rule file edited during the run, and reverts the rest", async () => {
    const ctx = await createSandboxContext();
    await writeFile(join(ctx.cwd, "AGENTS.md"), "# mine\n", "utf8");
    const plan = await buildPlan(ctx, [masterPromptPlugin], {
      agemonVersion: "9.9.9",
    });
    const fileOperations = plan.operations.filter(
      (op) => op.action !== "conflict",
    );
    const laterOp = operation({
      id: "later:pkg:install",
      capabilityId: "later",
      resourceId: "pkg",
      targetPath: "pkg",
      action: "install-package",
    });
    let editedAgents = "";
    const later = createFilePlugin({
      id: "later",
      onInstall: async (installCtx) => {
        const agentsPath = join(installCtx.cwd, "AGENTS.md");
        editedAgents = `${await readFile(agentsPath, "utf8")}user line\n`;
        await writeFile(agentsPath, editedAgents);
        throw new Error("later failed");
      },
    });

    const rollbackError = await captureRollbackError(
      applyPlan(ctx, [masterPromptPlugin, later], {
        plan: { ...plan, operations: [...fileOperations, laterOp] },
        approved: [...fileOperations, laterOp],
        ...IGNORED_ISOLATION,
      }),
    );

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      editedAgents,
    );
    expect(
      (await readdir(ctx.cwd)).filter((name) =>
        name.startsWith("AGENTS.md.agemon-original"),
      ),
    ).toEqual(["AGENTS.md.agemon-original"]);
    expect(ctx.manifest.getActions().map((entry) => entry.target)).toEqual([
      "AGENTS.md",
    ]);
    expect(rollbackError.rollback.manualCleanup).toHaveLength(1);
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });
});

describe("applyPlan with a resolved conflict", () => {
  it("writes the pointer when a conflict was approved as 'replace'", async () => {
    const ctx = await createSandboxContext();
    await writeFile(
      join(ctx.cwd, "CLAUDE.md"),
      "# Claude\n\nIndependent rules.\n",
      "utf8",
    );
    const plan = await buildPlan(ctx, [masterPromptPlugin], {
      agemonVersion: "9.9.9",
    });
    const conflict = plan.operations.find(
      (op) => op.targetPath === "CLAUDE.md",
    );
    expect(conflict?.action).toBe("conflict");

    await applyPlan(ctx, [masterPromptPlugin], {
      plan,
      approved: plan.operations.map((op) =>
        op === conflict ? { ...op, action: "replace" as const } : op,
      ),
      ...IGNORED_ISOLATION,
    });

    await expect(
      readFile(join(ctx.cwd, "CLAUDE.md"), "utf8"),
    ).resolves.toContain("AGENTS.md");
    await expect(
      readFile(join(ctx.cwd, "CLAUDE.md"), "utf8"),
    ).resolves.not.toContain("Independent rules.");
  });
});
