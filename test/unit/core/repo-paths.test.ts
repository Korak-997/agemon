import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RefusedPathError } from "../../../src/core/files.js";
import {
  resolveInsideRepo,
  resolveStateDirectory,
} from "../../../src/core/repo-paths.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-repo-paths-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("resolveInsideRepo", () => {
  it.each([
    "",
    "/etc/x",
    "../outside",
    "./../x",
    "a/../../x",
    "a/..",
    "AGENTS\0.md",
    ".git/config",
    "sub/.git/hooks/pre-commit",
    ".agemon/state.json",
    "AGENTS\u001b[2J.md",
    `${"x".repeat(256)}.md`,
  ])("refuses %j", async (relativePath) => {
    const repoRoot = await createSandbox();

    await expect(resolveInsideRepo(repoRoot, relativePath)).rejects.toThrow(
      RefusedPathError,
    );
  });

  it.each([
    "AGENTS.md",
    "..foo",
    ".github/copilot-instructions.md",
    "a/b/c/d/e/f/g.md",
  ])("accepts %j and joins it to the repo root", async (relativePath) => {
    const repoRoot = await createSandbox();

    await expect(resolveInsideRepo(repoRoot, relativePath)).resolves.toBe(
      join(repoRoot, relativePath),
    );
  });

  it.each([
    ["outside the repo", "outside"],
    ["back inside the repo", "inside"],
    ["nowhere", "dangling"],
  ])(
    "refuses a path under a symlinked parent pointing %s",
    async (_label, kind) => {
      const repoRoot = await createSandbox();
      const outside = await createSandbox();
      await mkdir(join(repoRoot, "real"));
      const linkTarget =
        kind === "outside"
          ? outside
          : kind === "inside"
            ? join(repoRoot, "real")
            : join(outside, "missing");
      await symlink(linkTarget, join(repoRoot, ".github"));

      await expect(
        resolveInsideRepo(repoRoot, ".github/copilot-instructions.md"),
      ).rejects.toThrow(RefusedPathError);
    },
  );

  it("accepts a repo root that is itself reached through a symlink", async () => {
    const realRoot = await createSandbox();
    const linkParent = await createSandbox();
    const linkedRoot = join(linkParent, "repo");
    await symlink(realRoot, linkedRoot);

    await expect(resolveInsideRepo(linkedRoot, "AGENTS.md")).resolves.toBe(
      join(linkedRoot, "AGENTS.md"),
    );
  });
});

describe("resolveStateDirectory", () => {
  it.each([
    [[], ".agemon"],
    [["backups"], ".agemon/backups"],
    [["backups", "master-prompt"], ".agemon/backups/master-prompt"],
  ])("refuses a symlinked %j", async (segments, linkedPath) => {
    const repoRoot = await createSandbox();
    const outside = await createSandbox();
    const parent = join(repoRoot, linkedPath, "..");
    await mkdir(parent, { recursive: true });
    await symlink(outside, join(repoRoot, linkedPath));

    await expect(
      resolveStateDirectory(repoRoot, segments, { create: true }),
    ).rejects.toThrow(/symlink or not a directory/);
    await expect(
      resolveStateDirectory(repoRoot, segments, { create: false }),
    ).rejects.toThrow(RefusedPathError);
  });

  it("refuses a regular file where a directory belongs", async () => {
    const repoRoot = await createSandbox();
    await writeFile(join(repoRoot, ".agemon"), "not a directory\n", "utf8");

    await expect(
      resolveStateDirectory(repoRoot, ["plans"], { create: true }),
    ).rejects.toThrow(RefusedPathError);
  });

  it("creates missing components in create mode", async () => {
    const repoRoot = await createSandbox();

    await expect(
      resolveStateDirectory(repoRoot, ["plans", "0123456789abcdef"], {
        create: true,
      }),
    ).resolves.toBe(join(repoRoot, ".agemon/plans/0123456789abcdef"));
  });

  it("returns null in read mode when a component is missing", async () => {
    const repoRoot = await createSandbox();
    await mkdir(join(repoRoot, ".agemon"));

    await expect(
      resolveStateDirectory(repoRoot, ["backups"], { create: false }),
    ).resolves.toBeNull();
  });
});
