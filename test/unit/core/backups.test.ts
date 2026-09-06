import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveImmutableBackupPath,
  writeImmutableBackup,
} from "../../../src/core/backups.js";
import { sha256Hex } from "../../../src/core/fingerprint.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-backups-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("writeImmutableBackup", () => {
  it("writes the pristine snapshot once and returns its checksum", async () => {
    const cwd = await createSandbox();

    const backup = await writeImmutableBackup(
      cwd,
      "rule-file:AGENTS.md",
      "original\n",
    );

    expect(backup.path).toBe(
      resolveImmutableBackupPath(cwd, "rule-file:AGENTS.md"),
    );
    expect(backup.checksum).toBe(sha256Hex("original\n"));
    await expect(readFile(backup.path, "utf8")).resolves.toBe("original\n");
  });

  it("never overwrites an existing backup for the same resource id", async () => {
    const cwd = await createSandbox();
    await writeImmutableBackup(cwd, "rule-file:AGENTS.md", "original\n");

    const secondBackup = await writeImmutableBackup(
      cwd,
      "rule-file:AGENTS.md",
      "user edited this later\n",
    );

    expect(secondBackup.checksum).toBe(sha256Hex("original\n"));
    await expect(readFile(secondBackup.path, "utf8")).resolves.toBe(
      "original\n",
    );
  });
});
