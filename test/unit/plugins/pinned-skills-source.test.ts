import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import type {
  RunSubprocessOptions,
  SubprocessResult,
} from "../../../src/core/subprocess-runner.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import {
  fetchPinnedSkillsSource,
  resolvePinnedSkillsSourceDirectory,
} from "../../../src/plugins/skills/pinned-source.js";

const PINNED_COMMIT = "1111111111111111111111111111111111111111";
const OTHER_COMMIT = "2222222222222222222222222222222222222222";
const REPOSITORY = {
  url: "https://example.invalid/agent-skills.git",
  commit: PINNED_COMMIT,
};
const SKILL_NAMES = ["web-design-guidelines", "writing-guidelines"];
const GIT_WITHOUT_HOOKS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
];

function gitSubcommand(args: string[]): string[] {
  return args.slice(GIT_WITHOUT_HOOKS.length);
}

let stateHome: string;
let originalStateHome: string | undefined;

beforeEach(async () => {
  originalStateHome = process.env.XDG_STATE_HOME;
  stateHome = await mkdtemp(join(tmpdir(), "agemon-pinned-source-test-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
  process.env.XDG_STATE_HOME = originalStateHome;
  await rm(stateHome, { recursive: true, force: true });
});

function regularTreeEntry(path: string): string {
  return `100644 blob ${"a".repeat(40)}\t${path}\n`;
}

function createGitRunner(
  overrides: {
    headCommit?: string;
    lsTree?: (skillPath: string) => string;
  } = {},
) {
  const run = vi.fn(
    async (
      _command: string,
      args: string[],
      _options?: RunSubprocessOptions,
    ): Promise<SubprocessResult> => {
      const [subcommand] = gitSubcommand(args);
      if (subcommand === "rev-parse") {
        return {
          code: 0,
          stdout: `${overrides.headCommit ?? PINNED_COMMIT}\n`,
          stderr: "",
        };
      }
      if (subcommand === "ls-tree") {
        const skillPath = args.at(-1) ?? "";
        const listing = overrides.lsTree
          ? overrides.lsTree(skillPath)
          : regularTreeEntry(`${skillPath}/SKILL.md`);
        return { code: 0, stdout: listing, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  const ctx = { run } as unknown as Pick<Context, "run">;
  return { ctx, run };
}

describe("fetchPinnedSkillsSource", () => {
  it("fetches exactly the pinned commit into its own state directory", async () => {
    const { ctx, run } = createGitRunner();

    await fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES);

    const sourceDirectory = resolvePinnedSkillsSourceDirectory(PINNED_COMMIT);
    expect(sourceDirectory).toBe(
      join(stateHome, "agemon", "skills-src", PINNED_COMMIT),
    );
    for (const [command, args] of run.mock.calls) {
      expect([command, ...args.slice(0, GIT_WITHOUT_HOOKS.length)]).toEqual([
        "git",
        ...GIT_WITHOUT_HOOKS,
      ]);
    }
    expect(
      run.mock.calls.map(([command, args]) => [
        command,
        ...gitSubcommand(args),
      ]),
    ).toEqual([
      ["git", "init", "-q"],
      ["git", "fetch", "--depth", "1", REPOSITORY.url, PINNED_COMMIT],
      ["git", "checkout", "-q", "FETCH_HEAD"],
      ["git", "rev-parse", "HEAD"],
      ["git", "ls-tree", "-r", "HEAD", "--", "skills/web-design-guidelines"],
      ["git", "ls-tree", "-r", "HEAD", "--", "skills/writing-guidelines"],
    ]);
    for (const [, , options] of run.mock.calls) {
      expect(options?.cwd).toBe(sourceDirectory);
      expect(options?.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_DIR: join(sourceDirectory, ".git"),
        GIT_WORK_TREE: sourceDirectory,
        GIT_INDEX_FILE: join(sourceDirectory, ".git", "index"),
      });
      expect(options?.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("discards an existing checkout before fetching", async () => {
    const sourceDirectory = resolvePinnedSkillsSourceDirectory(PINNED_COMMIT);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "edited"), "x", "utf8");
    const { ctx } = createGitRunner();

    await fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES);

    expect(existsSync(join(sourceDirectory, "edited"))).toBe(false);
  });

  it("rejects a checkout whose HEAD is not the pinned commit, naming both", async () => {
    const { ctx } = createGitRunner({ headCommit: OTHER_COMMIT });

    await expect(
      fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES),
    ).rejects.toThrow(
      new RegExp(
        `${PINNED_COMMIT}.*${OTHER_COMMIT}|${OTHER_COMMIT}.*${PINNED_COMMIT}`,
        "u",
      ),
    );
  });

  it("rejects a skill that contains a symlink, naming its path", async () => {
    const { ctx } = createGitRunner({
      lsTree: (skillPath) =>
        `${regularTreeEntry(`${skillPath}/SKILL.md`)}120000 blob ${"b".repeat(40)}\t${skillPath}/escape\n`,
    });

    await expect(
      fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES),
    ).rejects.toThrow(/skills\/web-design-guidelines\/escape/u);
  });

  it("rejects a pinned commit that lacks a requested skill", async () => {
    const { ctx } = createGitRunner({
      lsTree: (skillPath) =>
        skillPath.endsWith("writing-guidelines")
          ? ""
          : regularTreeEntry(`${skillPath}/SKILL.md`),
    });

    await expect(
      fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES),
    ).rejects.toThrow(/skills\/writing-guidelines/u);
  });

  it("reports a failed git step with its output", async () => {
    const run = vi.fn(
      async (_command: string, args: string[]): Promise<SubprocessResult> =>
        gitSubcommand(args)[0] === "fetch"
          ? {
              code: 128,
              stdout: "",
              stderr: "fatal: remote error: not our ref",
            }
          : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = { run } as unknown as Pick<Context, "run">;

    await expect(
      fetchPinnedSkillsSource(ctx, REPOSITORY, SKILL_NAMES),
    ).rejects.toThrow(/git fetch.*not our ref/su);
  });
});

describe("fetchPinnedSkillsSource with real git", () => {
  const inheritedGitVariables = ["GIT_DIR", "GIT_WORK_TREE"] as const;
  const originalGitVariables = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of inheritedGitVariables) {
      originalGitVariables.set(name, process.env[name]);
    }
  });

  afterEach(() => {
    for (const name of inheritedGitVariables) {
      const original = originalGitVariables.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    }).trim();
  }

  async function createCommittedRepository(
    files: Record<string, string>,
  ): Promise<string> {
    const repository = await mkdtemp(join(stateHome, "repo-"));
    git(repository, ["init", "-q", "-b", "main"]);
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(repository, path, ".."), { recursive: true });
      await writeFile(join(repository, path), contents, "utf8");
    }
    git(repository, ["add", "."]);
    git(repository, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
    ]);
    return repository;
  }

  it("never touches the repository named by an inherited GIT_DIR/GIT_WORK_TREE", async () => {
    const upstream = await createCommittedRepository({
      "skills/demo/SKILL.md": "# demo\n",
    });
    const victim = await createCommittedRepository({ "notes.txt": "mine\n" });
    const upstreamCommit = git(upstream, ["rev-parse", "HEAD"]);
    const victimCommit = git(victim, ["rev-parse", "HEAD"]);
    process.env.GIT_DIR = join(victim, ".git");
    process.env.GIT_WORK_TREE = victim;

    await fetchPinnedSkillsSource(
      { run: runSubprocess },
      { url: upstream, commit: upstreamCommit },
      ["demo"],
    );

    expect(git(victim, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(victim, ["rev-parse", "HEAD"])).toBe(victimCommit);
    expect(git(victim, ["status", "--porcelain"])).toBe("");
    expect(
      await readFile(
        join(
          resolvePinnedSkillsSourceDirectory(upstreamCommit),
          "skills",
          "demo",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toBe("# demo\n");
  });
});
