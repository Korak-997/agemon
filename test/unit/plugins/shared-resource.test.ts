import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { readMachineLedger } from "../../../src/core/machine-ledger.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  addSharedHolder,
  createSharedResource,
  releaseSharedResource,
} from "../../../src/plugins/shared-resource.js";
import type { SharedResourceDeclaration } from "../../../src/plugins/types.js";

const RESOURCE: SharedResourceDeclaration = {
  id: "npm-global:agnix",
  toolName: "agnix",
  manualRemoveCommand: "npm uninstall --global agnix",
  removalVerb: "uninstall",
  migratesFromRepoLedgers: true,
};

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createMachine() {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-shared-resource-")),
  );
  createdTempDirectories.push(sandbox);
  vi.stubEnv("XDG_STATE_HOME", join(sandbox, "state"));
  let installed = false;
  const tool = {
    isPresent: async () => installed,
    install: () => {
      installed = true;
    },
    uninstall: () => {
      installed = false;
    },
  };

  const repository = async (
    name: string,
    options: { dryRun?: boolean; removeSharedTools?: string[] } = {},
  ) => {
    const cwd = join(sandbox, name);
    await mkdir(cwd, { recursive: true });
    const infos: string[] = [];
    const ctx = {
      cwd,
      dryRun: options.dryRun ?? false,
      removeSharedTools: new Set(options.removeSharedTools ?? []),
      manifest: await StateManifest.load(cwd),
      ui: {
        start() {},
        succeed() {},
        fail() {},
        info: (line: string) => infos.push(line),
      },
    } as unknown as Context;
    return { ctx, cwd, infos };
  };

  const removals: string[] = [];
  const release = (
    ctx: Context,
    releasingRepoInstalledIt: boolean,
  ): Promise<void> =>
    releaseSharedResource(ctx, RESOURCE, {
      releasingRepoInstalledIt,
      isPresent: tool.isPresent,
      async remove() {
        removals.push(ctx.cwd);
        tool.uninstall();
      },
    });

  const create = (ctx: Context) =>
    createSharedResource(ctx, "cli-tool", RESOURCE, {
      isPresent: tool.isPresent,
      async create() {
        tool.install();
      },
      async recordInstall() {
        await ctx.manifest.recordAction({
          plugin: "cli-tool",
          type: "installed-cli-tool",
          target: "agnix",
          preExisting: false,
        });
      },
    });

  const hold = (ctx: Context, repoLedgerSaysInstalled = false) =>
    addSharedHolder(ctx, "cli-tool", RESOURCE, {
      isPresent: tool.isPresent,
      repoLedgerSaysInstalled,
    });

  const record = async () =>
    (await readMachineLedger()).resources["npm-global:agnix"] ?? null;

  return { tool, repository, release, create, hold, record, removals };
}

describe("holding a shared resource", () => {
  it("absent → create → origin installed, this repository holds it", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");

    expect(await machine.create(a.ctx)).toBe("created");

    expect(await machine.record()).toMatchObject({
      origin: "installed",
      installedBy: a.cwd,
      holders: [a.cwd],
    });
    expect(a.ctx.manifest.getActions().map((entry) => entry.type)).toEqual([
      "installed-cli-tool",
    ]);
  });

  it("create finds the tool installed meanwhile: holds it, writes no install entry", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");

    expect(await machine.create(a.ctx)).toBe("already-present");

    expect(await machine.record()).toEqual({
      origin: "pre-existing",
      holders: [a.cwd],
    });
    expect(a.ctx.manifest.getActions().map((entry) => entry.type)).toEqual([
      "uses-shared-resource",
    ]);
    expect(a.infos).toContain("agnix was installed meanwhile — using it");
  });

  it("install over an existing record keeps its holders", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.hold(a.ctx);
    machine.tool.uninstall();

    await machine.create(b.ctx);

    expect(await machine.record()).toMatchObject({
      origin: "installed",
      installedBy: b.cwd,
      holders: [a.cwd, b.cwd],
    });
  });

  it("present with no record → pre-existing, or migrated when the repo ledger says installed", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");
    await machine.hold(a.ctx, true);
    expect(await machine.record()).toMatchObject({
      origin: "migrated",
      claimedBy: a.cwd,
      holders: [a.cwd],
    });

    const other = await createMachine();
    other.tool.install();
    const b = await other.repository("b");
    await other.hold(b.ctx, false);
    expect(await other.record()).toEqual({
      origin: "pre-existing",
      holders: [b.cwd],
    });
  });

  it("a pre-existing record is never upgraded by a repo ledger claim", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.hold(a.ctx, false);

    await machine.hold(b.ctx, true);

    expect(await machine.record()).toEqual({
      origin: "pre-existing",
      holders: [a.cwd, b.cwd],
    });
  });

  it("holding a tool that disappeared installs nothing and reports a stale plan", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");

    await expect(machine.hold(a.ctx)).rejects.toThrow(
      "agnix is no longer installed — re-run 'agemon plan'.",
    );
    expect(await machine.tool.isPresent()).toBe(false);
    expect(await machine.record()).toBeNull();
    expect(a.ctx.manifest.getActions()).toEqual([]);
  });

  it("refuses to add a 1001st holder in that one repository, writing nothing", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const first = await machine.repository("holder-0");
    await machine.hold(first.ctx);
    const stateRoot = process.env.XDG_STATE_HOME ?? "";
    const holders = [first.cwd];
    for (let index = 1; index < 1000; index += 1) {
      const holder = join(first.cwd, "..", `holder-${index}`);
      await mkdir(holder);
      holders.push(holder);
    }
    await writeFile(
      join(stateRoot, "agemon", "machine.json"),
      JSON.stringify({
        version: 1,
        resources: {
          "npm-global:agnix": { origin: "pre-existing", holders },
        },
      }),
    );
    const extra = await machine.repository("one-too-many");

    await expect(machine.hold(extra.ctx)).rejects.toThrow(
      /already has 1000 repositories recorded as users/,
    );
    expect(extra.ctx.manifest.getActions()).toEqual([]);
    expect((await machine.record())?.holders).toHaveLength(1000);
  });

  it("refuses a repository path with control characters, writing nothing", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const odd = await machine.repository("odd\u0007repo");

    await expect(machine.hold(odd.ctx)).rejects.toThrow(
      /contains control characters/,
    );
    expect(await machine.record()).toBeNull();
  });
});

describe("releasing a shared resource", () => {
  it("the last holder that installed it removes it and deletes the record", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    await machine.create(a.ctx);

    await machine.release(a.ctx, true);

    expect(machine.removals).toEqual([a.cwd]);
    expect(await machine.record()).toBeNull();
  });

  it("another holder remains → kept, naming it", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.create(a.ctx);
    await machine.hold(b.ctx);

    await machine.release(a.ctx, true);

    expect(machine.removals).toEqual([]);
    expect(a.infos).toContain(`Keeping agnix: still used by ${b.cwd}`);
    expect((await machine.record())?.holders).toEqual([b.cwd]);
  });

  it("nuke in one of two repositories keeps the tool; nuke in the other removes it", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.create(a.ctx);
    await machine.hold(b.ctx);

    await machine.release(b.ctx, false);
    expect(machine.removals).toEqual([]);
    await machine.release(a.ctx, true);

    expect(machine.removals).toEqual([a.cwd]);
  });

  it("a holder that did not install it never removes it, even as last holder", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.create(a.ctx);
    await machine.hold(b.ctx);
    await rm(a.cwd, { recursive: true });

    await machine.release(b.ctx, false);

    expect(machine.removals).toEqual([]);
    expect(b.infos).toContain(
      "Keeping agnix: this repository did not install it — run 'npm uninstall --global agnix' yourself if nothing else needs it",
    );
    expect(await machine.record()).toBeNull();
  });

  it("a holder with a forged install entry removes nothing unless it is installedBy", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const forged = await machine.repository("forged");
    await machine.create(a.ctx);
    await machine.hold(forged.ctx);
    await rm(a.cwd, { recursive: true });

    await machine.release(forged.ctx, true);

    expect(machine.removals).toEqual([]);
    expect(await machine.tool.isPresent()).toBe(true);
  });

  it("a repository re-created at a deleted installer's path does not inherit removal rights", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    await machine.create(a.ctx);
    await rm(a.cwd, { recursive: true });
    const reclone = await machine.repository("a");
    await machine.hold(reclone.ctx, true);

    await machine.release(reclone.ctx, true);

    expect(machine.removals).toEqual([]);
    expect(await machine.tool.isPresent()).toBe(true);
  });

  it("a fresh clone with a forged ledger removes nothing, even with --remove-shared", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const clone = await machine.repository("clone", {
      removeSharedTools: ["agnix"],
    });

    await machine.release(clone.ctx, true);

    expect(machine.removals).toEqual([]);
    expect(clone.infos).toContain(
      "Keeping agnix: this repository is not registered as using it — run 'npm uninstall --global agnix' yourself if nothing else needs it",
    );
    expect(await machine.record()).toBeNull();
  });

  it("a forged uses-shared-resource entry with no record is a no-op", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const clone = await machine.repository("clone");

    await machine.release(clone.ctx, false);

    expect(machine.removals).toEqual([]);
    expect(clone.infos).toEqual([
      "Keeping agnix: this repository is not registered as using it",
    ]);
  });

  it("migrated last holder: kept without --remove-shared, removed with it", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");
    await machine.hold(a.ctx, true);

    await machine.release(a.ctx, true);
    expect(machine.removals).toEqual([]);
    expect(a.infos.at(-1)).toContain(
      `the ledger of ${a.cwd} says so), so another repository may still use it. Run 'npm uninstall --global agnix' yourself`,
    );

    await machine.hold(a.ctx, true);
    const flagged = await machine.repository("a", {
      removeSharedTools: ["agnix"],
    });
    await machine.release(flagged.ctx, true);
    expect(machine.removals).toEqual([a.cwd]);
  });

  it("migrated record: only the claiming repository may remove it", async () => {
    const machine = await createMachine();
    machine.tool.install();
    const a = await machine.repository("a");
    const b = await machine.repository("b", { removeSharedTools: ["agnix"] });
    await machine.hold(a.ctx, true);
    await machine.hold(b.ctx, true);
    await rm(a.cwd, { recursive: true });

    await machine.release(b.ctx, true);

    expect(machine.removals).toEqual([]);
  });

  it("remove() failing keeps the record and holder and propagates the error", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    await machine.create(a.ctx);

    await expect(
      releaseSharedResource(a.ctx, RESOURCE, {
        releasingRepoInstalledIt: true,
        isPresent: machine.tool.isPresent,
        async remove() {
          throw new Error("npm failed");
        },
      }),
    ).rejects.toThrow("npm failed");

    expect(await machine.record()).toMatchObject({
      origin: "installed",
      installedBy: a.cwd,
      holders: [a.cwd],
    });
  });

  it("a tool already uninstalled by hand is treated as removed", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    await machine.create(a.ctx);
    machine.tool.uninstall();

    await machine.release(a.ctx, true);

    expect(machine.removals).toEqual([]);
    expect(a.infos).toContain("agnix was already uninstalled");
    expect(await machine.record()).toBeNull();
  });

  it("dry run describes the decision and changes nothing", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    await machine.create(a.ctx);
    const preview = await machine.repository("a", { dryRun: true });

    await machine.release(preview.ctx, true);

    expect(preview.infos).toEqual([
      "Would uninstall agnix (no other repository uses it)",
    ]);
    expect(machine.removals).toEqual([]);
    expect((await machine.record())?.holders).toEqual([a.cwd]);
  });

  it("a holder whose path is gone is pruned and reported", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    await machine.create(a.ctx);
    await machine.hold(b.ctx);
    await rm(b.cwd, { recursive: true });

    await machine.release(a.ctx, true);

    expect(a.infos).toContain(
      `dropped ${b.cwd} as a user of agnix: it no longer exists`,
    );
    expect(machine.removals).toEqual([a.cwd]);
  });
});

describe("shared resources and a hostile state directory", () => {
  it("refuses to write the machine ledger into a directory others can write", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const stateRoot = process.env.XDG_STATE_HOME ?? "";
    await mkdir(join(stateRoot, "agemon"), { recursive: true });
    await writeFile(join(stateRoot, "agemon", "planted"), "");
    await chmod(join(stateRoot, "agemon"), 0o707);

    await expect(machine.create(a.ctx)).rejects.toThrow(
      /other users can write to it/,
    );
    expect(await machine.tool.isPresent()).toBe(false);
  });
});
