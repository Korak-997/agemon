import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  identitiesAcceptingEntry,
  receiptIdentitiesFromStats,
} from "../../../src/core/machine-ledger.js";
import {
  parseLedgerEntries,
  StateManifest,
} from "../../../src/core/state-manifest.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createMachine() {
  const root = await mkdtemp(join(tmpdir(), "agemon-receipts-"));
  createdTempDirectories.push(root);
  const stateHome = join(root, "state");
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  const repository = async (name: string) => {
    const cwd = join(root, name);
    await mkdir(cwd, { recursive: true });
    return cwd;
  };
  return { root, keyPath: join(stateHome, "agemon", "ledger-key"), repository };
}

const SKILL = {
  plugin: "skills",
  type: "installed-skill",
  target: "geo-audit",
  preExisting: false,
};

const AGENT = {
  plugin: "agents",
  type: "managed-agent-file",
  target: ".claude/agents/reviewer.md",
  preExisting: false,
  resourceId: "agent-file:reviewer",
  fingerprintAfter: "a".repeat(64),
};

const COARSE_FILESYSTEM_TIMESTAMP_MS = 20;

// The kernel stamps inodes from a coarse clock, so a directory created and
// filled within one tick reports birth time == change time, and agemon then
// binds receipts to the path instead of the birth time.
function waitPastCoarseFilesystemTimestamps(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, COARSE_FILESYSTEM_TIMESTAMP_MS),
  );
}

async function rewriteLedger(
  cwd: string,
  change: (actions: Record<string, unknown>[]) => void,
): Promise<void> {
  const path = join(cwd, ".agemon", "state.json");
  const ledger = JSON.parse(await readFile(path, "utf8"));
  change(ledger.actions);
  await writeFile(path, JSON.stringify(ledger));
}

describe("ledger receipts", () => {
  it("recordAction signs entries in a fresh repository and a reloaded ledger confirms them", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    const manifest = await StateManifest.load(cwd);

    const entry = await manifest.recordAction(SKILL);

    expect(entry.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.isConfirmed(entry)).toBe(true);
    const reloaded = await StateManifest.load(cwd);
    expect(reloaded.getConfirmedActions()).toEqual([entry]);
  });

  it.each([
    [
      "has no receipt",
      (entry: Record<string, unknown>) => delete entry.receipt,
    ],
    [
      "had a field changed",
      (entry: Record<string, unknown>) => (entry.target = "other-skill"),
    ],
    [
      "has a malformed receipt",
      (entry: Record<string, unknown>) => (entry.receipt = "zz"),
    ],
    [
      "has a receipt of the wrong length",
      (entry: Record<string, unknown>) => (entry.receipt = "ab".repeat(16)),
    ],
  ])(
    "an entry that %s loads as an unconfirmed claim",
    async (_case, change) => {
      const machine = await createMachine();
      const cwd = await machine.repository("repo");
      await (await StateManifest.load(cwd)).recordAction(SKILL);
      await rewriteLedger(cwd, (actions) => change(actions[0]));

      const reloaded = await StateManifest.load(cwd);

      expect(reloaded.getActions()).toHaveLength(1);
      expect(reloaded.getConfirmedActions()).toEqual([]);
    },
  );

  it("a ledger copied into another directory is a claim there; a moved repository stays confirmed", async () => {
    const machine = await createMachine();
    const original = await machine.repository("original");
    await waitPastCoarseFilesystemTimestamps();
    await (await StateManifest.load(original)).recordAction(SKILL);
    const copy = join(machine.root, "copy");
    await cp(original, copy, { recursive: true });
    const moved = join(machine.root, "moved");
    await rename(original, moved);

    expect((await StateManifest.load(copy)).getConfirmedActions()).toEqual([]);
    expect(
      (await StateManifest.load(moved)).getConfirmedActions(),
    ).toHaveLength(1);
  });

  it("updateResourceEntry re-signs a confirmed entry and leaves a claim unconfirmed", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    const manifest = await StateManifest.load(cwd);
    await manifest.recordAction(AGENT);

    await manifest.updateResourceEntry("agent-file:reviewer", {
      fingerprintAfter: "b".repeat(64),
    });
    expect((await StateManifest.load(cwd)).getConfirmedActions()).toHaveLength(
      1,
    );

    await rewriteLedger(cwd, (actions) => delete actions[0].receipt);
    const claimed = await StateManifest.load(cwd);
    await claimed.updateResourceEntry("agent-file:reviewer", {
      fingerprintAfter: "c".repeat(64),
    });
    expect((await StateManifest.load(cwd)).getConfirmedActions()).toEqual([]);
  });

  it("updateResourceEntry patches the confirmed entry when a claim shares its resourceId", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    await (await StateManifest.load(cwd)).recordAction(AGENT);
    await rewriteLedger(cwd, (actions) =>
      actions.unshift({ ...actions[0], id: "claim", receipt: null }),
    );
    const manifest = await StateManifest.load(cwd);

    const patched = await manifest.updateResourceEntry("agent-file:reviewer", {
      fingerprintAfter: "d".repeat(64),
    });

    expect(patched?.id).not.toBe("claim");
    expect(manifest.getConfirmedActions()).toEqual([patched]);
  });

  it("recording a confirmed entry drops claims for the same resource", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    const manifest = await StateManifest.load(cwd);
    await manifest.recordAction(AGENT);
    await manifest.recordAction(SKILL);
    await rewriteLedger(cwd, (actions) => {
      for (const action of actions) {
        delete action.receipt;
      }
    });
    const reloaded = await StateManifest.load(cwd);

    await reloaded.recordAction({ ...AGENT, fingerprintAfter: "e".repeat(64) });
    await reloaded.recordAction(SKILL);

    expect(reloaded.getActions()).toHaveLength(2);
    expect(reloaded.getConfirmedActions()).toHaveLength(2);
  });

  it("restoreActions and a journal round trip keep each entry's confirmation", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    const manifest = await StateManifest.load(cwd);
    await manifest.recordAction(SKILL);
    const journaled = parseLedgerEntries(
      JSON.parse(JSON.stringify(manifest.getActions())),
    );
    await manifest.recordAction(AGENT);

    await manifest.restoreActions(journaled ?? []);

    const reloaded = await StateManifest.load(cwd);
    expect(reloaded.getConfirmedActions()).toHaveLength(1);
    expect(reloaded.getConfirmedActions()[0].target).toBe("geo-audit");
  });

  it("without a ledger key nothing is confirmed and loading creates no key", async () => {
    const machine = await createMachine();
    const cwd = await machine.repository("repo");
    await mkdir(join(cwd, ".agemon"));
    await writeFile(
      join(cwd, ".agemon", "state.json"),
      JSON.stringify({
        version: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        os: "linux",
        actions: [
          {
            id: "legacy-1",
            plugin: "skills",
            type: "installed-skill",
            target: "geo-audit",
            preExisting: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const manifest = await StateManifest.load(cwd);

    expect(manifest.getActions()).toHaveLength(1);
    expect(manifest.getConfirmedActions()).toEqual([]);
    await expect(readFile(machine.keyPath)).rejects.toThrow();
  });

  it.each([
    ["is not 64 hex characters", "not-a-key\n", 0o600],
    ["can be read by other users", `${"f".repeat(64)}\n`, 0o644],
  ])(
    "a ledger key that %s fails with the move-aside message",
    async (_case, contents, mode) => {
      const machine = await createMachine();
      const cwd = await machine.repository("repo");
      await (await StateManifest.load(cwd)).recordAction(SKILL);
      await writeFile(machine.keyPath, contents);
      await chmod(machine.keyPath, mode);

      await expect(StateManifest.load(cwd)).rejects.toThrow(
        "Move it aside to continue; agemon then treats every existing ledger entry as unconfirmed.",
      );
    },
  );

  it("two repositories recording at once end up with one key that both use", async () => {
    const machine = await createMachine();
    const [a, b] = await Promise.all([
      machine.repository("a").then(StateManifest.load),
      machine.repository("b").then(StateManifest.load),
    ]);

    await Promise.all([a.recordAction(SKILL), b.recordAction(SKILL)]);

    expect(
      (await StateManifest.load(join(machine.root, "a"))).getConfirmedActions(),
    ).toHaveLength(1);
    expect(
      (await StateManifest.load(join(machine.root, "b"))).getConfirmedActions(),
    ).toHaveLength(1);
  });
});

describe("receipt repository identity", () => {
  const BIRTH_MS = 1_800_000_000_000;
  const stats = {
    ino: 4242n,
    birthtimeNs: BigInt(BIRTH_MS) * 1_000_000n,
    ctimeNs: BigInt(BIRTH_MS + 5_000) * 1_000_000n,
  };
  const birthForm = `4242:${stats.birthtimeNs}`;

  it("signs with the inode and birth time when the birth time is real", () => {
    expect(receiptIdentitiesFromStats(stats, "/r")).toEqual({
      signing: birthForm,
      byBirthTime: birthForm,
      byPath: "4242:/r",
      usableBirthTimeMs: BIRTH_MS,
    });
  });

  it("signs with the inode and realpath when the birth time is zero", () => {
    expect(
      receiptIdentitiesFromStats({ ...stats, birthtimeNs: 0n }, "/r"),
    ).toEqual({
      signing: "4242:/r",
      byBirthTime: null,
      byPath: "4242:/r",
      usableBirthTimeMs: null,
    });
  });

  it("signs with the inode and realpath when the birth time equals the change time", () => {
    const sameAsChange = { ...stats, birthtimeNs: stats.ctimeNs };
    expect(receiptIdentitiesFromStats(sameAsChange, "/r")).toMatchObject({
      signing: "4242:/r",
      usableBirthTimeMs: null,
    });
  });

  it("accepts the realpath form only for entries written after the directory was born", () => {
    const identities = receiptIdentitiesFromStats(stats, "/r");
    const after = new Date(BIRTH_MS + 10).toISOString();
    const before = new Date(BIRTH_MS - 60_000).toISOString();

    expect(identitiesAcceptingEntry(identities, after)).toEqual([
      birthForm,
      "4242:/r",
    ]);
    expect(identitiesAcceptingEntry(identities, before)).toEqual([birthForm]);
    expect(identitiesAcceptingEntry(identities, "not a date")).toEqual([
      birthForm,
    ]);
  });

  it("accepts the realpath form for any entry when the directory has no usable birth time", () => {
    const identities = receiptIdentitiesFromStats(
      { ...stats, birthtimeNs: 0n },
      "/r",
    );
    expect(
      identitiesAcceptingEntry(identities, new Date(0).toISOString()),
    ).toEqual(["4242:/r"]);
  });
});
