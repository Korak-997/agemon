import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RefusedPathError } from "../../../src/core/files.js";
import {
  resolveInsideRepo,
  resolveRepositoryRoot,
  resolveStateDirectory,
} from "../../../src/core/repo-paths.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-repo-paths-test-")),
  );
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("resolveRepositoryRoot", () => {
  async function createNestedRepo(): Promise<{
    repoRoot: string;
    nested: string;
    home: string;
  }> {
    const sandbox = await createSandbox();
    const repoRoot = join(sandbox, "repo");
    const nested = join(repoRoot, "sub", "dir");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    return { repoRoot, nested, home: join(sandbox, "home") };
  }

  it("resolves a subdirectory to the directory that holds .git, with a notice", async () => {
    const { repoRoot, nested, home } = await createNestedRepo();

    await expect(resolveRepositoryRoot(nested, home)).resolves.toEqual({
      root: repoRoot,
      notice: `Using repository root ${repoRoot} (not the current directory).`,
    });
  });

  it("uses the current directory silently when it holds .git", async () => {
    const { repoRoot, home } = await createNestedRepo();

    await expect(resolveRepositoryRoot(repoRoot, home)).resolves.toEqual({
      root: repoRoot,
      notice: null,
    });
  });

  it("falls back to the current directory outside any repository", async () => {
    const sandbox = await createSandbox();

    await expect(
      resolveRepositoryRoot(sandbox, join(sandbox, "home")),
    ).resolves.toEqual({ root: sandbox, notice: null });
  });

  it("accepts a gitdir file, as in a git worktree", async () => {
    const { repoRoot, nested, home } = await createNestedRepo();
    const worktree = join(repoRoot, "sub");
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere/.git\n");

    await expect(resolveRepositoryRoot(nested, home)).resolves.toMatchObject({
      root: worktree,
    });
  });

  it("ignores core.worktree, which git would follow to an ancestor", async () => {
    const { repoRoot, nested, home } = await createNestedRepo();
    await writeFile(
      join(repoRoot, ".git", "config"),
      "[core]\n\tworktree = /\n",
    );

    await expect(resolveRepositoryRoot(nested, home)).resolves.toMatchObject({
      root: repoRoot,
    });
  });

  it("stops at a symlinked .git instead of walking on to the outer repo", async () => {
    const { repoRoot, home } = await createNestedRepo();
    const inner = join(repoRoot, "unpacked");
    const nested = join(inner, "deeper");
    await mkdir(nested, { recursive: true });
    await symlink(join(repoRoot, ".git"), join(inner, ".git"));

    await expect(resolveRepositoryRoot(nested, home)).resolves.toEqual({
      root: nested,
      notice: `Not using ${inner} as the repository root (its .git is not a directory or gitdir file).`,
    });
  });

  it("uses the current directory silently when its own .git is a symlink", async () => {
    const { repoRoot, home } = await createNestedRepo();
    const inner = join(repoRoot, "unpacked");
    await mkdir(inner);
    await symlink(join(repoRoot, ".git"), join(inner, ".git"));

    await expect(resolveRepositoryRoot(inner, home)).resolves.toEqual({
      root: inner,
      notice: null,
    });
  });

  it("never adopts an ancestor repository owned by another user", async () => {
    const { repoRoot, nested, home } = await createNestedRepo();
    const otherUid = (process.getuid?.() ?? 0) + 1;

    await expect(
      resolveRepositoryRoot(nested, home, otherUid),
    ).resolves.toEqual({
      root: nested,
      notice: `Not using ${repoRoot} as the repository root (it is owned by another user).`,
    });
  });

  it("stops at a .git file that is not a gitdir file", async () => {
    const { repoRoot, home } = await createNestedRepo();
    const inner = join(repoRoot, "unpacked");
    const nested = join(inner, "deeper");
    await mkdir(nested, { recursive: true });
    await writeFile(join(inner, ".git"), "not a gitdir pointer\n");

    await expect(resolveRepositoryRoot(nested, home)).resolves.toEqual({
      root: nested,
      notice: `Not using ${inner} as the repository root (its .git is not a directory or gitdir file).`,
    });
  });

  it("never adopts a repository that contains the home directory", async () => {
    const { repoRoot } = await createNestedRepo();
    const home = join(repoRoot, "home");
    const project = join(home, "project");
    await mkdir(project, { recursive: true });

    await expect(resolveRepositoryRoot(project, home)).resolves.toEqual({
      root: project,
      notice: `Not using ${repoRoot} as the repository root (it contains your home directory); run 'git init' here or run agemon from the repository root.`,
    });
  });

  it("still adopts the home directory when agemon runs there", async () => {
    const { repoRoot } = await createNestedRepo();

    await expect(resolveRepositoryRoot(repoRoot, repoRoot)).resolves.toEqual({
      root: repoRoot,
      notice: null,
    });
  });
});

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
