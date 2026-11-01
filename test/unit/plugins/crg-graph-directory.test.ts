import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphDirectoryProblem } from "../../../src/plugins/crg/graph-directory.js";

const readdirOverride = vi.hoisted(() => ({
  entryOfUnknownType: null as { directory: string; name: string } | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = (await actual.readdir(...args)) as unknown as Dirent[];
      const unknown = readdirOverride.entryOfUnknownType;
      if (unknown === null || !String(args[0]).endsWith(unknown.directory)) {
        return entries;
      }
      return [
        ...entries.filter((entry) => entry.name !== unknown.name),
        entryOfUnknownType(unknown.name),
      ];
    },
  };
});

function entryOfUnknownType(name: string): Dirent {
  const no = () => false;
  return {
    name,
    isFile: no,
    isDirectory: no,
    isSymbolicLink: no,
    isFIFO: no,
    isSocket: no,
    isBlockDevice: no,
    isCharacterDevice: no,
  } as unknown as Dirent;
}

const ENTRY_LIMIT = 20_000;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  readdirOverride.entryOfUnknownType = null;
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<{ repo: string; outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agemon-graph-")));
  createdTempDirectories.push(root);
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(outside);
  execFileSync("git", ["init", "-q", repo]);
  return { repo, outside };
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function commitAll(repo: string): void {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "fixture",
  );
}

function trackedProblem(entry: string): string {
  return `1 path(s) where crg writes its graph are tracked by git; crg would write through repository content. Remove them from the repository (git rm -r --cached -- '${entry}') and run agemon again.`;
}

describe("graphDirectoryProblem — tracked content", () => {
  it("reports a committed .code-review-graph", async () => {
    const { repo } = await createRepository();
    await mkdir(join(repo, ".code-review-graph"));
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "");
    commitAll(repo);

    expect(await graphDirectoryProblem(repo)).toBe(
      trackedProblem(".code-review-graph"),
    );
  });

  it("reports a committed mixed-case .Code-Review-Graph on a case-insensitive setup", async () => {
    const { repo } = await createRepository();
    git(repo, "config", "core.ignorecase", "true");
    await mkdir(join(repo, ".Code-Review-Graph"));
    await writeFile(join(repo, ".Code-Review-Graph", "graph.db"), "");
    commitAll(repo);

    expect(await graphDirectoryProblem(repo)).toBe(
      trackedProblem(".Code-Review-Graph"),
    );
    git(repo, "rm", "-r", "-q", "--cached", "--", ".Code-Review-Graph");
    expect(await graphDirectoryProblem(repo)).toBeNull();
  });

  it("reports the same from a subdirectory of the repository", async () => {
    const { repo } = await createRepository();
    await mkdir(join(repo, ".code-review-graph"));
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "");
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "file"), "");
    commitAll(repo);

    expect(await graphDirectoryProblem(join(repo, "sub"))).toBe(
      trackedProblem("../.code-review-graph"),
    );
  });

  it("reports a committed root .code-review-graph.db", async () => {
    const { repo } = await createRepository();
    await writeFile(join(repo, ".code-review-graph.db"), "");
    commitAll(repo);

    expect(await graphDirectoryProblem(repo)).toBe(
      trackedProblem(".code-review-graph.db"),
    );
  });

  it("fails closed when git cannot answer", async () => {
    const { repo } = await createRepository();
    await rm(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: /nonexistent/agemon-git\n");

    expect(await graphDirectoryProblem(repo)).toMatch(
      /^could not check whether \.code-review-graph is tracked: /,
    );
  });

  it("checks only the files on disk in a directory that is not a repository", async () => {
    const { repo } = await createRepository();
    await rm(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".code-review-graph"));
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "");

    expect(await graphDirectoryProblem(repo)).toBeNull();
  });
});

describe("graphDirectoryProblem — files on disk", () => {
  it("finds nothing when .code-review-graph is missing", async () => {
    const { repo } = await createRepository();

    expect(await graphDirectoryProblem(repo)).toBeNull();
  });

  it("finds nothing in a clean untracked directory", async () => {
    const { repo } = await createRepository();
    await mkdir(join(repo, ".code-review-graph", "wiki"), { recursive: true });
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "");
    await writeFile(join(repo, ".code-review-graph", "wiki", "index.md"), "");
    await writeFile(join(repo, ".code-review-graph.db"), "");

    expect(await graphDirectoryProblem(repo)).toBeNull();
  });

  it("reports a symlinked .code-review-graph", async () => {
    const { repo, outside } = await createRepository();
    await symlink(outside, join(repo, ".code-review-graph"));

    expect(await graphDirectoryProblem(repo)).toBe(
      ".code-review-graph is a symlink or file, not a directory; remove it, then run code-review-graph build",
    );
  });

  it("reports a symlink inside wiki/", async () => {
    const { repo, outside } = await createRepository();
    await mkdir(join(repo, ".code-review-graph", "wiki"), { recursive: true });
    await symlink(
      join(outside, "index.md"),
      join(repo, ".code-review-graph", "wiki", "index.md"),
    );

    expect(await graphDirectoryProblem(repo)).toBe(
      ".code-review-graph/wiki/index.md is a symlink, not a regular file or directory; crg would write through it. Remove .code-review-graph (code-review-graph build recreates it) and run agemon again.",
    );
  });

  it("reports a FIFO graph.db-wal", async () => {
    const { repo } = await createRepository();
    await mkdir(join(repo, ".code-review-graph"));
    execFileSync("mkfifo", [join(repo, ".code-review-graph", "graph.db-wal")]);

    expect(await graphDirectoryProblem(repo)).toBe(
      ".code-review-graph/graph.db-wal is a FIFO, not a regular file or directory; crg would write through it. Remove .code-review-graph (code-review-graph build recreates it) and run agemon again.",
    );
  });

  it("reports a symlinked root .code-review-graph.db", async () => {
    const { repo, outside } = await createRepository();
    await symlink(
      join(outside, "authorized_keys"),
      join(repo, ".code-review-graph.db"),
    );

    expect(await graphDirectoryProblem(repo)).toBe(
      ".code-review-graph.db at the repository root is a symlink, not a regular file; crg would write through it. Remove it and run agemon again.",
    );
  });

  it(`stops after ${ENTRY_LIMIT} entries and names the remedy`, async () => {
    const { repo } = await createRepository();
    const graph = join(repo, ".code-review-graph");
    await mkdir(graph);
    for (let index = 0; index <= ENTRY_LIMIT; index += 1) {
      await writeFile(join(graph, `entry-${index}`), "");
    }

    expect(await graphDirectoryProblem(repo)).toBe(
      ".code-review-graph has more than 20 000 entries, so agemon can't check it for links; remove the directory (code-review-graph build recreates it) and run agemon again.",
    );
  }, 60_000);

  it("skips an entry of unknown type that is gone by the time it is checked", async () => {
    const { repo } = await createRepository();
    await mkdir(join(repo, ".code-review-graph"));
    readdirOverride.entryOfUnknownType = {
      directory: ".code-review-graph",
      name: "graph.db-journal",
    };

    expect(await graphDirectoryProblem(repo)).toBeNull();
  });

  it("checks an entry of unknown type with lstat", async () => {
    const { repo, outside } = await createRepository();
    await mkdir(join(repo, ".code-review-graph"));
    await symlink(outside, join(repo, ".code-review-graph", "wiki"));
    readdirOverride.entryOfUnknownType = {
      directory: ".code-review-graph",
      name: "wiki",
    };

    expect(await graphDirectoryProblem(repo)).toMatch(
      /^\.code-review-graph\/wiki is a symlink/,
    );
  });
});
