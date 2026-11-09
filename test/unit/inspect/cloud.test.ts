import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCloudReadiness,
  findToolsCloudSessionsNeed,
} from "../../../src/inspect/cloud.js";
import { CODE_REVIEW_GRAPH_PACKAGE_SPEC } from "../../../src/plugins/pins.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );
}

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-cloud-test-"));
  createdDirectories.push(directory);
  return directory;
}

async function createRepository(): Promise<string> {
  const directory = await createDirectory();
  git(directory, "init", "-q");
  return directory;
}

async function writeRepoFile(
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const path = join(cwd, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function commitAll(cwd: string): void {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "test");
}

describe("findToolsCloudSessionsNeed", () => {
  it("finds code-review-graph run directly by a hook", () => {
    expect(
      findToolsCloudSessionsNeed([
        {
          hooks: {
            SessionStart: [
              { hooks: [{ command: "code-review-graph status" }] },
            ],
          },
        },
      ]),
    ).toEqual(["code-review-graph"]);
  });

  it("finds it later in a compound command", () => {
    expect(
      findToolsCloudSessionsNeed([
        { command: "cd sub && code-review-graph update" },
      ]),
    ).toEqual(["code-review-graph"]);
  });

  it("does not need it when uvx fetches it", () => {
    expect(
      findToolsCloudSessionsNeed([
        {
          mcpServers: {
            graph: { command: "uvx", args: ["code-review-graph", "serve"] },
          },
        },
        { command: "uvx code-review-graph status" },
      ]),
    ).toEqual([]);
  });

  it("ignores absent and malformed config", () => {
    expect(
      findToolsCloudSessionsNeed([null, "text", { command: 3 }, []]),
    ).toEqual([]);
  });
});

describe("checkCloudReadiness", () => {
  it("reports untracked, changed and ignored agent config separately", async () => {
    const cwd = await createRepository();
    await writeRepoFile(cwd, "CLAUDE.md", "committed\n");
    await writeRepoFile(cwd, ".gitignore", "/.claude/agents/\n");
    commitAll(cwd);
    await writeRepoFile(cwd, "CLAUDE.md", "edited\n");
    await writeRepoFile(cwd, ".claude/skills/demo/SKILL.md", "new\n");
    await writeRepoFile(cwd, ".claude/agents/demo.md", "ignored\n");
    await writeRepoFile(cwd, "unrelated.txt", "not agent config\n");

    const report = await checkCloudReadiness(cwd, []);

    expect(report.uncommittedPaths).toEqual(["CLAUDE.md", ".claude/skills/"]);
    expect(report.ignoredPaths).toEqual([".claude/agents/"]);
    expect(report.gitCheckError).toBeNull();
  });

  it("names the new path of a renamed file", async () => {
    const cwd = await createRepository();
    await writeRepoFile(cwd, ".claude/skills/old/SKILL.md", "same\n");
    commitAll(cwd);
    git(cwd, "mv", ".claude/skills/old", ".claude/skills/new");

    const report = await checkCloudReadiness(cwd, []);

    expect(report.uncommittedPaths).toEqual([".claude/skills/new/SKILL.md"]);
  });

  it("counts only unpushed commits that touch agent config", async () => {
    const remote = await createDirectory();
    git(remote, "init", "-q", "--bare");
    const cwd = await createRepository();
    await writeRepoFile(cwd, "CLAUDE.md", "one\n");
    commitAll(cwd);
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "push", "-qu", "origin", "HEAD");
    await writeRepoFile(cwd, "CLAUDE.md", "two\n");
    commitAll(cwd);
    await writeRepoFile(cwd, "unrelated.txt", "x\n");
    commitAll(cwd);

    const report = await checkCloudReadiness(cwd, []);

    expect(report.unpushedCommits).toBe(1);
  });

  it("leaves the unpushed count unknown without an upstream", async () => {
    const cwd = await createRepository();
    await writeRepoFile(cwd, "CLAUDE.md", "one\n");
    commitAll(cwd);

    const report = await checkCloudReadiness(cwd, []);

    expect(report.unpushedCommits).toBeNull();
    expect(report.gitCheckError).toBeNull();
  });

  it("says so outside a git repository", async () => {
    const cwd = await createDirectory();

    const report = await checkCloudReadiness(cwd, []);

    expect(report.gitCheckError).toContain("not a git repository");
  });

  it("offers a pinned setup script only when a tool is needed", async () => {
    const cwd = await createRepository();

    const without = await checkCloudReadiness(cwd, []);
    const needed = await checkCloudReadiness(cwd, [
      { command: "code-review-graph status" },
    ]);

    expect(without.setupScript).toBeNull();
    expect(needed.toolsToInstall).toEqual(["code-review-graph"]);
    expect(needed.setupScript).toContain(CODE_REVIEW_GRAPH_PACKAGE_SPEC);
    expect(needed.setupScript?.startsWith("#!/bin/bash\n")).toBe(true);
  });
});
