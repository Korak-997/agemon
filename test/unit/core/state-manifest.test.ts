import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateManifest } from "../../../src/core/state-manifest.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-state-manifest-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

const V1_MANIFEST = {
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  os: "linux",
  actions: [
    {
      id: "1111",
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: true,
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    {
      id: "2222",
      plugin: "crg",
      type: "preexisting-binary",
      target: "code-review-graph",
      preExisting: true,
      createdAt: "2026-08-02T00:00:00.000Z",
    },
  ],
};

async function writeV1Manifest(cwd: string): Promise<string> {
  const manifestPath = join(cwd, ".agemon", "state.json");
  await mkdir(join(cwd, ".agemon"), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(V1_MANIFEST, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

describe("StateManifest ledger v2", () => {
  it("migrates a v1 manifest, keeps the actions, and writes a pre-migration backup", async () => {
    const cwd = await createSandbox();
    const manifestPath = await writeV1Manifest(cwd);

    const manifest = await StateManifest.load(cwd);

    const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(persisted.version).toBe(2);
    expect(persisted.actions).toHaveLength(2);
    expect(persisted.actions[0]).toMatchObject({
      id: "1111",
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: true,
      ownershipMode: "created",
      fingerprintBefore: null,
      fingerprintAfter: null,
      backup: null,
    });
    expect(persisted.actions[1].ownershipMode).toBe("recorded-key");

    const backup = JSON.parse(
      await readFile(join(cwd, ".agemon", "state.v1.bak"), "utf8"),
    );
    expect(backup).toEqual(V1_MANIFEST);

    expect(manifest.getActions().map((action) => action.id)).toEqual([
      "1111",
      "2222",
    ]);
  });

  it("does not re-migrate a manifest that is already v2", async () => {
    const cwd = await createSandbox();
    await writeV1Manifest(cwd);
    await StateManifest.load(cwd);

    await rm(join(cwd, ".agemon", "state.v1.bak"), { force: true });
    await StateManifest.load(cwd);

    await expect(
      readFile(join(cwd, ".agemon", "state.v1.bak"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records and persists the v2 provenance fields", async () => {
    const cwd = await createSandbox();
    const manifest = await StateManifest.load(cwd);

    await manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: true,
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "created",
      fingerprintBefore: "before-hash",
      fingerprintAfter: "after-hash",
      backup: { path: "/tmp/x.bak", checksum: "backup-hash" },
    });

    const reloaded = await StateManifest.load(cwd);
    const [entry] = reloaded.getActions();
    expect(entry).toMatchObject({
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "created",
      fingerprintBefore: "before-hash",
      fingerprintAfter: "after-hash",
      backup: { path: "/tmp/x.bak", checksum: "backup-hash" },
    });
  });

  it("refuses an unrecognised schema version", async () => {
    const cwd = await createSandbox();
    await mkdir(join(cwd, ".agemon"), { recursive: true });
    await writeFile(
      join(cwd, ".agemon", "state.json"),
      JSON.stringify({
        version: 99,
        createdAt: "x",
        updatedAt: "y",
        os: "linux",
        actions: [],
      }),
      "utf8",
    );

    await expect(StateManifest.load(cwd)).rejects.toThrow(
      /Unrecognised state manifest version/,
    );
  });
});
