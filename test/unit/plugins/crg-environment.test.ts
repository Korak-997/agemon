import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crgSubprocessEnvironment } from "../../../src/plugins/crg/environment.js";

const createdTempDirectories: string[] = [];
const COMMIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@e"];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createPartialCloneWithHostileUploadPack() {
  const root = await mkdtemp(join(tmpdir(), "agemon-crg-lazy-fetch-"));
  createdTempDirectories.push(root);
  const upstream = join(root, "upstream");
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  await writeFile(join(upstream, "f.txt"), "a\n");
  git(upstream, "add", "f.txt");
  git(upstream, ...COMMIT_IDENTITY, "commit", "-qm", "a");
  await writeFile(join(upstream, "f.txt"), "b\n");
  git(upstream, ...COMMIT_IDENTITY, "commit", "-qam", "b");
  git(upstream, "config", "uploadpack.allowFilter", "true");

  const clone = join(root, "clone");
  execFileSync("git", [
    "clone",
    "-q",
    "--filter=blob:none",
    "--no-checkout",
    `file://${upstream}`,
    clone,
  ]);
  git(clone, "checkout", "-q", "main");
  const marker = join(root, "UPLOADPACK_RAN");
  git(
    clone,
    "config",
    "remote.origin.uploadpack",
    `touch ${marker}; git-upload-pack`,
  );
  const base = git(clone, "rev-list", "--max-parents=0", "HEAD").trim();
  return { clone, marker, base };
}

function gitWith(
  environment: Record<string, string>,
  cwd: string,
  ...args: string[]
) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

describe("crg's git environment", () => {
  it("does not lazily fetch in a partial clone, so a configured upload-pack never runs", async () => {
    const { clone, marker, base } =
      await createPartialCloneWithHostileUploadPack();

    gitWith(
      crgSubprocessEnvironment(),
      clone,
      "diff",
      "--unified=0",
      base,
      "--",
    );

    expect(existsSync(marker)).toBe(false);
  });

  it("refuses every transport through GIT_ALLOW_PROTOCOL even without GIT_NO_LAZY_FETCH", async () => {
    const { clone, marker, base } =
      await createPartialCloneWithHostileUploadPack();

    const result = gitWith(
      { GIT_ALLOW_PROTOCOL: "" },
      clone,
      "diff",
      "--unified=0",
      base,
      "--",
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("still lists changed files with diff --name-only in a partial clone", async () => {
    const { clone, base } = await createPartialCloneWithHostileUploadPack();

    const result = gitWith(
      crgSubprocessEnvironment(),
      clone,
      "diff",
      "--name-only",
      base,
      "--",
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("f.txt");
  });
});
