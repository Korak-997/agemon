import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptIdentities } from "../../../src/core/machine-ledger.js";

const identity = vi.hoisted(() => ({
  current: null as ReceiptIdentities | null,
}));

vi.mock("../../../src/core/machine-ledger.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../src/core/machine-ledger.js")
    >();
  return {
    ...original,
    repositoryReceiptIdentities: async () => {
      if (identity.current === null) {
        throw new Error("test did not set a repository identity");
      }
      return identity.current;
    },
  };
});

const { StateManifest } = await import("../../../src/core/state-manifest.js");

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  identity.current = null;
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

const PATH_FORM = "77:/work/repo";
const SKILL = {
  plugin: "skills",
  type: "installed-skill",
  target: "geo-audit",
  preExisting: false,
};

function directoryWithoutBirthTime(): ReceiptIdentities {
  return {
    signing: PATH_FORM,
    byBirthTime: null,
    byPath: PATH_FORM,
    usableBirthTimeMs: null,
  };
}

function directoryBornAt(birthMs: number): ReceiptIdentities {
  const byBirthTime = `77:${birthMs}000000`;
  return {
    signing: byBirthTime,
    byBirthTime,
    byPath: PATH_FORM,
    usableBirthTimeMs: birthMs,
  };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agemon-receipt-replay-"));
  createdTempDirectories.push(root);
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  return cwd;
}

describe("path-form receipts", () => {
  it("do not confirm entries in a directory born after they were written at the same path and inode", async () => {
    const cwd = await createRepository();
    identity.current = directoryWithoutBirthTime();
    await (await StateManifest.load(cwd)).recordAction(SKILL);

    identity.current = directoryBornAt(Date.now() + 60_000);
    const replayed = await StateManifest.load(cwd);

    expect(replayed.getActions()).toHaveLength(1);
    expect(replayed.getConfirmedActions()).toEqual([]);
  });

  it("still confirm entries written just after the directory was born", async () => {
    const cwd = await createRepository();
    identity.current = directoryWithoutBirthTime();
    await (await StateManifest.load(cwd)).recordAction(SKILL);

    identity.current = directoryBornAt(Date.now() - 5);
    expect((await StateManifest.load(cwd)).getConfirmedActions()).toHaveLength(
      1,
    );
  });

  it("are re-signed in birth-time form on the next ledger write, so a later move keeps them", async () => {
    const cwd = await createRepository();
    identity.current = directoryWithoutBirthTime();
    await (await StateManifest.load(cwd)).recordAction(SKILL);
    const birthMs = Date.now() - 5;
    identity.current = directoryBornAt(birthMs);
    await (await StateManifest.load(cwd)).recordAction({
      ...SKILL,
      target: "geo-content",
    });

    identity.current = { ...directoryBornAt(birthMs), byPath: "77:/moved" };
    expect((await StateManifest.load(cwd)).getConfirmedActions()).toHaveLength(
      2,
    );
  });
});
