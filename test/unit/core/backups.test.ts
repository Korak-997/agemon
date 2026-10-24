import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  immutableBackupCandidates,
  replaceStaleBackup,
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

describe("backup file names", () => {
  it("gives colliding sanitized resource ids distinct file names", async () => {
    const cwd = await createSandbox();

    expect(resolveImmutableBackupPath(cwd, "rule-file:a/b")).not.toBe(
      resolveImmutableBackupPath(cwd, "rule-file:a_b"),
    );
  });

  it("does not treat a legacy-named file as the immutable backup", async () => {
    const cwd = await createSandbox();
    await mkdir(join(cwd, ".agemon/backups"), { recursive: true });
    await writeFile(
      join(cwd, ".agemon/backups/rule-file_AGENTS.md.bak"),
      "legacy or colliding contents\n",
      "utf8",
    );

    const backup = await writeImmutableBackup(
      cwd,
      "rule-file:AGENTS.md",
      "current\n",
    );

    await expect(readFile(backup.path, "utf8")).resolves.toBe("current\n");
  });
});

describe("replaceStaleBackup", () => {
  it("rewrites a backup whose contents differ and keeps a matching one", async () => {
    const cwd = await createSandbox();
    await writeImmutableBackup(cwd, "rule-file:CLAUDE.md", "stale\n");

    const replaced = await replaceStaleBackup(
      cwd,
      "rule-file:CLAUDE.md",
      "current\n",
    );
    expect(replaced.checksum).toBe(sha256Hex("current\n"));
    await expect(readFile(replaced.path, "utf8")).resolves.toBe("current\n");

    const kept = await replaceStaleBackup(
      cwd,
      "rule-file:CLAUDE.md",
      "current\n",
    );
    expect(kept).toEqual(replaced);
  });
});

describe("immutableBackupCandidates", () => {
  it("lists the new and legacy names, and keeps a recorded path only when it is one of them", async () => {
    const cwd = await createSandbox();
    const legacy = join(cwd, ".agemon/backups/rule-file_AGENTS.md.bak");

    expect(
      immutableBackupCandidates(cwd, "rule-file:AGENTS.md", legacy),
    ).toEqual([legacy, resolveImmutableBackupPath(cwd, "rule-file:AGENTS.md")]);
  });

  it("ignores a recorded path that names another resource's backup", async () => {
    const cwd = await createSandbox();
    const otherResourceBackup = resolveImmutableBackupPath(
      cwd,
      "rule-file:CLAUDE.md",
    );

    expect(
      immutableBackupCandidates(
        cwd,
        "rule-file:AGENTS.md",
        otherResourceBackup,
      ),
    ).not.toContain(otherResourceBackup);
  });

  it("ignores a recorded path that is not directly in .agemon/backups", async () => {
    const cwd = await createSandbox();

    for (const recorded of [
      "/etc/passwd",
      join(cwd, "AGENTS.md"),
      join(cwd, ".agemon/backups/../state.json"),
      join(cwd, ".agemon/backups/linked-dir/x.bak"),
    ]) {
      expect(
        immutableBackupCandidates(cwd, "rule-file:AGENTS.md", recorded),
      ).not.toContain(recorded);
    }
  });
});
