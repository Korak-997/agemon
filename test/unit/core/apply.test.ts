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
