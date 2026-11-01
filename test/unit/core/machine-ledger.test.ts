import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directoryIdentity,
  readMachineLedger,
  updateSharedResource,
} from "../../../src/core/machine-ledger.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox() {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-machine-ledger-")),
  );
  createdTempDirectories.push(sandbox);
  const stateRoot = join(sandbox, "state");
  vi.stubEnv("XDG_STATE_HOME", stateRoot);
  const repoA = join(sandbox, "repo-a");
  const repoB = join(sandbox, "repo-b");
  await mkdir(repoA);
  await mkdir(repoB);
  return {
    repoA,
    repoB,
    ledgerPath: join(stateRoot, "agemon", "machine.json"),
  };
}

async function writeLedger(path: string, contents: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(contents));
}

function ledgerWith(resources: unknown) {
  return { version: 1, resources };
}

describe("machine ledger", () => {
  it("a missing ledger reads as empty and reading creates nothing", async () => {
    const { ledgerPath } = await createSandbox();

    expect(await readMachineLedger()).toEqual({ version: 1, resources: {} });
    await expect(stat(join(ledgerPath, ".."))).rejects.toThrow();
  });

  it.each([
    ["an unknown version", { version: 2, resources: {} }, /expected version 1/],
    [
      "an unknown resource id",
      ledgerWith({ "pipx:evil": { origin: "pre-existing", holders: [] } }),
      /unknown resource/,
    ],
    [
      "a bad origin",
      ledgerWith({
        "pipx:code-review-graph": { origin: "stolen", holders: [] },
      }),
      /origin/,
    ],
    [
      "a relative holder",
      ledgerWith({
        "pipx:code-review-graph": {
          origin: "pre-existing",
          holders: ["repo"],
        },
      }),
      /holders\[0\]/,
    ],
    [
      "a control-character holder",
      ledgerWith({
        "pipx:code-review-graph": {
          origin: "pre-existing",
          holders: ["/tmp/a\nb"],
        },
      }),
      /holders\[0\]/,
    ],
    [
      "a duplicate holder",
      ledgerWith({
        "pipx:code-review-graph": {
          origin: "pre-existing",
          holders: ["/tmp/a", "/tmp/a"],
        },
      }),
      /twice/,
    ],
    [
      "too many holders",
      ledgerWith({
        "pipx:code-review-graph": {
          origin: "pre-existing",
          holders: Array.from({ length: 1001 }, (_, index) => `/tmp/r${index}`),
        },
      }),
      /more than 1000/,
    ],
    [
      "an installed record without installedBy",
      ledgerWith({
        "pipx:code-review-graph": { origin: "installed", holders: [] },
      }),
      /installedBy/,
    ],
  ])("refuses %s, naming the file", async (_label, contents, detail) => {
    const { ledgerPath } = await createSandbox();
    await writeLedger(ledgerPath, contents);

    await expect(readMachineLedger()).rejects.toThrow(detail);
    await expect(readMachineLedger()).rejects.toThrow(ledgerPath);
  });

  it("refuses a symlinked machine.json", async () => {
    const { ledgerPath, repoA } = await createSandbox();
    await mkdir(join(ledgerPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(join(repoA, "real.json"), JSON.stringify(ledgerWith({})));
    await symlink(join(repoA, "real.json"), ledgerPath);

    await expect(readMachineLedger()).rejects.toThrow(/not a regular file/);
  });

  it("update prunes holders whose path no longer exists and reports them", async () => {
    const { ledgerPath, repoA, repoB } = await createSandbox();
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "pipx:code-review-graph": {
          origin: "installed",
          installedBy: repoA,
          ownerDirectoryId: await directoryIdentity(repoA),
          holders: [repoA, repoB],
        },
      }),
    );
    await rm(repoB, { recursive: true });
    const pruned: string[] = [];

    const seen = await updateSharedResource(
      "pipx:code-review-graph",
      async (record) => ({ record, result: record?.holders }),
      (holder) => pruned.push(holder),
    );

    expect(seen).toEqual([repoA]);
    expect(pruned).toEqual([repoB]);
    expect(
      (await readMachineLedger()).resources["pipx:code-review-graph"]?.holders,
    ).toEqual([repoA]);
  });

  it("a record whose installer directory was replaced at the same path reads as pre-existing", async () => {
    const { ledgerPath, repoA } = await createSandbox();
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "npm-global:agnix": {
          origin: "installed",
          installedBy: repoA,
          ownerDirectoryId: await directoryIdentity(repoA),
          holders: [repoA],
        },
      }),
    );
    await rm(repoA, { recursive: true });
    await mkdir(repoA);

    const seen = await updateSharedResource(
      "npm-global:agnix",
      async (record) => ({ record, result: record }),
      () => {},
    );

    expect(seen).toEqual({ origin: "pre-existing", holders: [repoA] });
  });

  it("a record whose owner identity has no birth time never keeps removal rights", async () => {
    const { ledgerPath, repoA } = await createSandbox();
    const identity = await directoryIdentity(repoA);
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "npm-global:agnix": {
          origin: "installed",
          installedBy: repoA,
          ownerDirectoryId: identity?.replace(/:\d+$/u, ":0"),
          holders: [repoA],
        },
      }),
    );

    const seen = await updateSharedResource(
      "npm-global:agnix",
      async (record) => ({ record, result: record }),
      () => {},
    );

    expect(seen).toEqual({ origin: "pre-existing", holders: [repoA] });
  });

  it("keeps a holder whose path can't be checked instead of failing or dropping it", async () => {
    const { ledgerPath, repoA } = await createSandbox();
    const blocked = join(repoA, "file", "repo");
    await writeFile(join(repoA, "file"), "");
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "npm-global:agnix": {
          origin: "pre-existing",
          holders: [repoA, blocked],
        },
      }),
    );

    const seen = await updateSharedResource(
      "npm-global:agnix",
      async (record) => ({ record, result: record?.holders }),
      () => {},
    );

    expect(seen).toEqual([repoA, blocked]);
  });

  it("a record whose installer no longer exists reads as pre-existing inside an update", async () => {
    const { ledgerPath, repoA, repoB } = await createSandbox();
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "npm-global:agnix": {
          origin: "installed",
          installedBy: repoB,
          ownerDirectoryId: await directoryIdentity(repoB),
          holders: [repoA, repoB],
        },
      }),
    );
    await rm(repoB, { recursive: true });

    const seen = await updateSharedResource(
      "npm-global:agnix",
      async (record) => ({ record, result: record }),
      () => {},
    );

    expect(seen).toEqual({ origin: "pre-existing", holders: [repoA] });
  });

  it("concurrent updates keep both holders", async () => {
    const { repoA, repoB } = await createSandbox();
    const addHolder = (repo: string) =>
      updateSharedResource(
        "npm-global:agnix",
        async (record) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            record: {
              origin: "pre-existing" as const,
              holders: [...(record?.holders ?? []), repo],
            },
            result: undefined,
          };
        },
        () => {},
      );

    await Promise.all([addHolder(repoA), addHolder(repoB)]);

    expect(
      [
        ...((await readMachineLedger()).resources["npm-global:agnix"]
          ?.holders ?? []),
      ].sort(),
    ).toEqual([repoA, repoB].sort());
  });

  it("never writes a ledger the reader would refuse", async () => {
    const { ledgerPath } = await createSandbox();

    await expect(
      updateSharedResource(
        "npm-global:agnix",
        async () => ({
          record: { origin: "pre-existing", holders: ["relative/repo"] },
          result: undefined,
        }),
        () => {},
      ),
    ).rejects.toThrow(/holders\[0\]/);
    await expect(readFile(ledgerPath, "utf8")).rejects.toThrow();
  });

  it("a null record deletes the resource", async () => {
    const { ledgerPath, repoA } = await createSandbox();
    await writeLedger(
      ledgerPath,
      ledgerWith({
        "npm-global:agnix": { origin: "pre-existing", holders: [repoA] },
      }),
    );

    await updateSharedResource(
      "npm-global:agnix",
      async () => ({ record: null, result: undefined }),
      () => {},
    );

    expect((await readMachineLedger()).resources).toEqual({});
    await expect(stat(ledgerPath)).rejects.toThrow();
  });

  it("writes machine.json 0600 inside a 0700 directory", async () => {
    const { ledgerPath, repoA } = await createSandbox();

    await updateSharedResource(
      "npm-global:agnix",
      async () => ({
        record: { origin: "pre-existing", holders: [repoA] },
        result: undefined,
      }),
      () => {},
    );

    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ledgerPath, ".."))).mode & 0o777).toBe(0o700);
  });
});
