import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findUntrustedGitConfig } from "../../../src/core/git-config-guard.js";
import { runRepositoryGit } from "../../../src/core/repository-git.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-repository-git-")),
  );
  createdTempDirectories.push(repository);
  execFileSync("git", ["init", "-q", repository]);
  return repository;
}

describe("runRepositoryGit", () => {
  it("runs real git even with AGEMON_FAKE_SUBPROCESS=1", async () => {
    const repository = await createRepository();
    vi.stubEnv("AGEMON_DEV", "1");
    vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");

    const result = await runRepositoryGit(repository, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);

    expect(result.stdout.trim()).toBe("true");
  });

  it("ignores an exported GIT_DIR and asks about the repository it names", async () => {
    const repository = await createRepository();
    const other = await createRepository();
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);

    const result = await runRepositoryGit(repository, [
      "rev-parse",
      "--absolute-git-dir",
    ]);

    expect(result.stdout.trim()).toBe(join(repository, ".git"));
  });

  it("keeps the git config guard on the repository it was given when GIT_DIR points elsewhere", async () => {
    const repository = await createRepository();
    const other = await createRepository();
    execFileSync("git", ["-C", other, "config", "diff.x.command", "/tmp/x"]);
    vi.stubEnv("GIT_DIR", join(other, ".git"));

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });
});
