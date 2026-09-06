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

async function writeManifest(cwd: string, manifest: unknown): Promise<string> {
  const manifestPath = join(cwd, ".agemon", "state.json");
  await mkdir(join(cwd, ".agemon"), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

async function writeV1Manifest(cwd: string): Promise<string> {
  return writeManifest(cwd, V1_MANIFEST);
}

const V2_MANIFEST = {
  version: 2,
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
      planId: null,
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "delimited-block",
      agemonVersion: null,
      fingerprintBefore: null,
      fingerprintAfter: "after-hash",
      backup: null,
    },
  ],
};

describe("StateManifest ledger v3", () => {
  it("migrates a v1 manifest, keeps the actions, and writes a pre-migration backup", async () => {
    const cwd = await createSandbox();
    const manifestPath = await writeV1Manifest(cwd);

    const manifest = await StateManifest.load(cwd);

    const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(persisted.version).toBe(3);
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
      desiredRevision: null,
      validation: null,
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

  it("migrates a v2 manifest to v3, keeping stored fields and backing it up once", async () => {
    const cwd = await createSandbox();
    const manifestPath = await writeManifest(cwd, V2_MANIFEST);

    await StateManifest.load(cwd);

    const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.actions[0]).toMatchObject({
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "delimited-block",
      fingerprintAfter: "after-hash",
      desiredRevision: null,
      validation: null,
    });

    const backup = JSON.parse(
      await readFile(join(cwd, ".agemon", "state.v1.bak"), "utf8"),
    );
    expect(backup).toEqual(V2_MANIFEST);

    await rm(join(cwd, ".agemon", "state.v1.bak"), { force: true });
    await StateManifest.load(cwd);
    await expect(
      readFile(join(cwd, ".agemon", "state.v1.bak"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not re-migrate a manifest that is already v3", async () => {
    const cwd = await createSandbox();
    await writeV1Manifest(cwd);
    await StateManifest.load(cwd);

    await rm(join(cwd, ".agemon", "state.v1.bak"), { force: true });
    await StateManifest.load(cwd);

    await expect(
      readFile(join(cwd, ".agemon", "state.v1.bak"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records and persists the provenance fields", async () => {
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

  it("patches a recorded resource entry in place and persists it", async () => {
    const cwd = await createSandbox();
    const manifest = await StateManifest.load(cwd);

    await manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: false,
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "delimited-block",
      fingerprintBefore: null,
      fingerprintAfter: "first-hash",
      desiredRevision: "rev-1",
    });

    const updated = await manifest.updateResourceEntry("rule-file:AGENTS.md", {
      fingerprintAfter: "second-hash",
      desiredRevision: "rev-2",
      validation: { ok: true },
    });
    expect(updated?.fingerprintAfter).toBe("second-hash");
    expect(updated?.fingerprintBefore).toBeNull();
    expect(updated?.desiredRevision).toBe("rev-2");
    expect(updated?.validation).toEqual({ ok: true });

    const reloaded = await StateManifest.load(cwd);
    expect(reloaded.getActions()[0].fingerprintAfter).toBe("second-hash");
    expect(reloaded.getActions()[0].validation).toEqual({ ok: true });

    expect(
      await manifest.updateResourceEntry("rule-file:missing", {
        fingerprintAfter: "x",
      }),
    ).toBeUndefined();
  });

  it("stamps recordAction entries with the recording agemon version", async () => {
    const cwd = await createSandbox();
    const manifest = await StateManifest.load(cwd);
    manifest.setRecordingAgemonVersion("4.5.6");

    await manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: "agemon-crg-daemon.service",
      preExisting: false,
    });

    expect((await StateManifest.load(cwd)).getActions()[0].agemonVersion).toBe(
      "4.5.6",
    );
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
