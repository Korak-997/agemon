import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import {
  directoryIdentity,
  readMachineLedger,
} from "../../../src/core/machine-ledger.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { resolveAgemonStateDirectory } from "../../../src/core/state-root.js";
import type {
  RunSubprocessOptions,
  SubprocessResult,
} from "../../../src/core/subprocess-runner.js";
import type {
  GitConfigGuard,
  GitConfigGuardResult,
} from "../../../src/core/untrusted-git-config.js";
import { hashLockedPipArgs } from "../../../src/plugins/crg/constraints.js";
import { crgPlugin } from "../../../src/plugins/crg/index.js";
import { daemonPlugin } from "../../../src/plugins/daemon/index.js";
import { CODE_REVIEW_GRAPH_VERSION } from "../../../src/plugins/pins.js";
import { describeSharedTools } from "../../../src/plugins/shared-resource.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { linkGitInto } from "../git-on-path.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const PINNED_SPEC = `code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`;
const METADATA_FIXTURE = join(
  process.cwd(),
  "test/unit/plugins/fixtures/pipx_metadata.json",
);
const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function writeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
}

function pipArgsFrom(installArgs: string[]): string[] {
  const flag = installArgs.find((arg) => arg.startsWith("--pip-args=")) ?? "";
  return [...flag.slice("--pip-args=".length).matchAll(/'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2],
  );
}

async function createPipxVenv(
  pipxHome: string,
  options: { withPython?: boolean; pipArgs?: string[] } = {},
): Promise<string> {
  const venv = join(pipxHome, "venvs", "code-review-graph");
  const binaryPath = join(venv, "bin", "code-review-graph");
  await writeExecutable(binaryPath);
  if (options.withPython !== false) {
    await writeExecutable(join(venv, "bin", "python"));
  }
  const metadata = JSON.parse(
    (await readFile(METADATA_FIXTURE, "utf8")).replaceAll("__VENV__", venv),
  );
  metadata.main_package.pip_args = options.pipArgs ?? [];
  await writeFile(join(venv, "pipx_metadata.json"), JSON.stringify(metadata));
  return binaryPath;
}

type RunCall = [string, string[], RunSubprocessOptions | undefined];

async function createTestContext(options: { dryRun?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agemon-crg-")));
  createdTempDirectories.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", "");
  vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "");
  vi.stubEnv("PIPX_HOME", undefined);
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  vi.stubEnv("CRG_HOME", undefined);
  vi.stubEnv("CRG_DATA_DIR", undefined);
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  const pipxHome = join(home, ".local", "share", "pipx");

  const calls: RunCall[] = [];
  const run = vi.fn(
    async (
      command: string,
      args: string[],
      runOptions?: RunSubprocessOptions,
    ): Promise<SubprocessResult> => {
      calls.push([command, args, runOptions]);
      if (command === "pipx" && args[0] === "install") {
        await createPipxVenv(pipxHome, { pipArgs: pipArgsFrom(args) });
      }
      if (command.endsWith("code-review-graph") && args[0] === "build") {
        await mkdir(join(repo, ".code-review-graph"), { recursive: true });
      }
      if (command.endsWith("code-review-graph") && args[0] === "--version") {
        return { code: 0, stdout: "code-review-graph 2.3.9\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  const infos: string[] = [];
  const context = {
    cwd: repo,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    dryRun: options.dryRun ?? false,
    run,
    manifest: await StateManifest.load(repo),
    ui: {
      start() {},
      succeed() {},
      fail() {},
      info(message: string) {
        infos.push(message);
      },
    },
  } as unknown as Context;
  const toolsRoot = join(root, "state", "agemon", "tools");
  return { context, run, calls, infos, home, repo, pipxHome, toolsRoot };
}

const SHIPPED_CONSTRAINTS = join(
  process.cwd(),
  "assets/tools/code-review-graph-constraints.txt",
);

async function shippedConstraintsCopyPath(toolsRoot: string): Promise<string> {
  const hash = createHash("sha256")
    .update(await readFile(SHIPPED_CONSTRAINTS, "utf8"))
    .digest("hex")
    .slice(0, 16);
  return join(toolsRoot, `code-review-graph-constraints-${hash}.txt`);
}

function commandsOf(calls: RunCall[]): string[][] {
  return calls.map(([command, args]) => [command, ...args]);
}

describe("crg plugin — install, verify, uninstall", () => {
  it("previews the pinned install", async () => {
    const { context } = await createTestContext();

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];

    expect(operation?.preview).toEqual({
      kind: "note",
      text: `pipx install ${PINNED_SPEC} (dependencies hash-locked); build the code graph for this repository`,
    });
  });

  it("installs the pin into the resolved pipx home, runs the installed binary, and uninstalls by name", async () => {
    const { context, calls, pipxHome, toolsRoot } = await createTestContext();
    const binaryPath = join(
      pipxHome,
      "venvs",
      "code-review-graph",
      "bin",
      "code-review-graph",
    );

    await crgPlugin.install(context);
    await crgPlugin.verify(context);
    await crgPlugin.uninstall(context);

    expect(commandsOf(calls)).toEqual([
      [
        "pipx",
        "install",
        PINNED_SPEC,
        `--pip-args=--require-hashes --only-binary=:all: -c '${await shippedConstraintsCopyPath(toolsRoot)}'`,
      ],
      [binaryPath, "build"],
      [binaryPath, "status"],
      ["pipx", "uninstall", "code-review-graph"],
    ]);
    const pipxEnvironments = calls
      .filter(([command]) => command === "pipx")
      .map(([, , options]) => options?.env?.PIPX_HOME);
    expect(pipxEnvironments).toEqual([pipxHome, pipxHome]);
  });

  it("fails install with the metadata path when pipx reports success but installed nothing", async () => {
    const { context, run, pipxHome } = await createTestContext();
    run.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));

    await expect(crgPlugin.install(context)).rejects.toThrow(
      `pipx reported success but ${join(pipxHome, "venvs", "code-review-graph", "pipx_metadata.json")} is missing or invalid`,
    );
  });

  it("refuses to install when PIPX_HOME is relative", async () => {
    const { context, calls } = await createTestContext();
    vi.stubEnv("PIPX_HOME", "relative/pipx");

    await expect(crgPlugin.install(context)).rejects.toThrow(/PIPX_HOME/);
    expect(calls).toEqual([]);
  });

  it("crg subprocesses get fsmonitor, hooks and submodule recursion disabled after existing GIT_CONFIG pairs, and no git transport", async () => {
    const { context, calls, home, repo } = await createTestContext();
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "user.name");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "someone");

    await crgPlugin.install(context);

    const buildCall = calls.find(([, args]) => args[0] === "build");
    expect(buildCall?.[2]?.env).toEqual({
      CRG_HOME: join(home, ".code-review-graph"),
      CRG_REPO_ROOT: repo,
      CRG_DATA_DIR: "",
      GIT_CONFIG_PARAMETERS: "",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
      GIT_CONFIG_KEY_3: "diff.ignoreSubmodules",
      GIT_CONFIG_VALUE_3: "all",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
    expect(buildCall?.[2]?.unsetEnv).toEqual(
      expect.arrayContaining(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]),
    );
    expect(buildCall?.[2]?.unsetEnv).not.toContain("GIT_CONFIG_COUNT");
  });

  it("pins build and status to agemon's repository root, overriding CRG_REPO_ROOT from the environment", async () => {
    const { context, calls, repo } = await createTestContext();
    vi.stubEnv("CRG_REPO_ROOT", "/somewhere/else");

    await crgPlugin.install(context);
    await crgPlugin.verify(context);

    const crgRepoRoots = calls
      .filter(([, args]) => args[0] === "build" || args[0] === "status")
      .map(([, args, options]) => [args[0], options?.env?.CRG_REPO_ROOT]);
    expect(crgRepoRoots).toEqual([
      ["build", repo],
      ["status", repo],
    ]);
  });

  it("overwrites a GIT_CONFIG_COUNT that is not a number", async () => {
    const { context, calls } = await createTestContext();
    vi.stubEnv("GIT_CONFIG_COUNT", "two");

    await crgPlugin.install(context);

    const buildCall = calls.find(([, args]) => args[0] === "build");
    expect(buildCall?.[2]?.env).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_KEY_2: "diff.ignoreSubmodules",
    });
  });

  it("says once that CRG_HOME and CRG_DATA_DIR from the environment are not used", async () => {
    const { context, infos } = await createTestContext();
    vi.stubEnv("CRG_DATA_DIR", "/somewhere/else");

    await crgPlugin.install(context);

    expect(infos.filter((line) => line.includes("CRG_DATA_DIR"))).toHaveLength(
      1,
    );
  });

  it("records graph-built as agemon's when .code-review-graph did not exist", async () => {
    const { context } = await createTestContext();

    await crgPlugin.install(context);

    expect(
      context.manifest
        .getActions()
        .find((action) => action.type === "graph-built"),
    ).toMatchObject({ target: ".code-review-graph", preExisting: false });
  });

  it("records graph-built as pre-existing when .code-review-graph already existed", async () => {
    const { context, repo } = await createTestContext();
    await mkdir(join(repo, ".code-review-graph"));

    await crgPlugin.install(context);

    expect(
      context.manifest
        .getActions()
        .find((action) => action.type === "graph-built"),
    ).toMatchObject({ target: ".code-review-graph", preExisting: true });
  });
});

describe("crg plugin — install edge cases", () => {
  it.each([
    ["linux", "sudo apt install pipx"],
    ["darwin", "brew install pipx"],
  ] as const)(
    "the missing-pipx hint on %s names %s",
    async (family, installCommand) => {
      const { context, run } = await createTestContext();
      run.mockResolvedValue({
        code: -1,
        stdout: "",
        stderr: "process spawn error: spawn pipx ENOENT",
      });

      await expect(
        crgPlugin.install({
          ...context,
          platform: { ...LINUX_TEST_PLATFORM, family },
        }),
      ).rejects.toThrow(
        `pipx is not on PATH, so code-review-graph cannot be installed; install it with '${installCommand}'`,
      );
    },
  );

  it("install refuses to build into a .code-review-graph symlink", async () => {
    const { context, calls, repo, home, infos } = await createTestContext();
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(repo, ".code-review-graph"));

    await crgPlugin.install(context);

    expect(calls.some(([, args]) => args[0] === "build")).toBe(false);
    expect(
      context.manifest
        .getActions()
        .some((action) => action.type === "graph-built"),
    ).toBe(false);
    expect(infos).toContain(
      "skipped the graph build: .code-review-graph is a symlink or file, not a directory; remove it, then run code-review-graph build",
    );
    expect(await crgPlugin.verify(context)).toMatchObject({ ok: false });
    expect(calls.some(([, args]) => args[0] === "status")).toBe(false);
  });

  it("install skips the build when a file inside .code-review-graph is a symlink, and verify fails without running status", async () => {
    const { context, calls, repo, home, infos } = await createTestContext();
    await mkdir(join(repo, ".code-review-graph"));
    await symlink(
      join(home, "authorized_keys"),
      join(repo, ".code-review-graph", "graph.db"),
    );
    const problem =
      ".code-review-graph/graph.db is a symlink, not a regular file or directory; crg would write through it. Remove .code-review-graph (code-review-graph build recreates it) and run agemon again.";

    await crgPlugin.install(context);

    expect(calls.some(([, args]) => args[0] === "build")).toBe(false);
    expect(infos).toContain(`skipped the graph build: ${problem}`);
    expect(await crgPlugin.verify(context)).toEqual({
      ok: false,
      detail: problem,
    });
    expect(calls.some(([, args]) => args[0] === "status")).toBe(false);
  });

  it("install skips the build when .code-review-graph is tracked by git", async () => {
    const { context, calls, repo, home, infos } = await createTestContext();
    const gitOnlyBin = join(home, "git-only-bin");
    await mkdir(gitOnlyBin);
    await linkGitInto(gitOnlyBin);
    vi.stubEnv("PATH", gitOnlyBin);
    execFileSync("git", ["init", "-q", repo]);
    await mkdir(join(repo, ".code-review-graph"));
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "");
    execFileSync("git", ["-C", repo, "add", "-A"]);

    await crgPlugin.install(context);

    expect(calls.some(([, args]) => args[0] === "build")).toBe(false);
    expect(infos).toContain(
      "skipped the graph build: 1 path(s) where crg writes its graph are tracked by git; crg would write through repository content. Remove them from the repository (git rm -r --cached -- '.code-review-graph') and run agemon again.",
    );
  });

  it("verify reports a symlink that appears after the build and does not run status", async () => {
    const { context, calls, repo, home } = await createTestContext();
    await crgPlugin.install(context);
    await symlink(
      join(home, "authorized_keys"),
      join(repo, ".code-review-graph", "graph.db-wal"),
    );

    expect(await crgPlugin.verify(context)).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /^\.code-review-graph\/graph\.db-wal is a symlink/,
      ),
    });
    expect(calls.some(([, args]) => args[0] === "status")).toBe(false);
  });

  it("records the graph before building, so a failed build is still cleaned up", async () => {
    const { context, run, repo } = await createTestContext();
    const succeed = run.getMockImplementation();
    run.mockImplementation(async (command, args, options) => {
      const result = await succeed?.(command, args, options);
      return args[0] === "build"
        ? { code: 1, stdout: "", stderr: "build failed" }
        : (result ?? { code: 0, stdout: "", stderr: "" });
    });

    await expect(crgPlugin.install(context)).rejects.toThrow("build failed");
    await crgPlugin.uninstall(context);

    expect(existsSync(join(repo, ".code-review-graph"))).toBe(false);
  });

  it("bounds the build failure message to the last 10 lines of stderr", async () => {
    const { context, run } = await createTestContext();
    const succeed = run.getMockImplementation();
    const stderr = Array.from({ length: 5_000 }, (_, i) => `trace ${i}`).join(
      "\n",
    );
    run.mockImplementation(async (command, args, options) => {
      const result = await succeed?.(command, args, options);
      return args[0] === "build"
        ? { code: 1, stdout: "", stderr }
        : (result ?? { code: 0, stdout: "", stderr: "" });
    });

    const failure = await crgPlugin.install(context).catch((error) => error);

    expect((failure as Error).message.split("\n").length).toBeLessThanOrEqual(
      11,
    );
    expect((failure as Error).message).toContain("trace 4999");
  });

  it("says the venv is broken when pipx leaves it without an interpreter", async () => {
    const { context, run, pipxHome } = await createTestContext();
    run.mockImplementation(async () => {
      await createPipxVenv(pipxHome, { withPython: false });
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(crgPlugin.install(context)).rejects.toThrow(
      "pipx reported success but the pipx venv is broken — run 'pipx uninstall code-review-graph', then 'agemon'",
    );
  });

  it("passes the crg environment to status and to the PATH --version probe", async () => {
    const { context, calls, home, repo } = await createTestContext();
    const binaryPath = join(home, "bin", "code-review-graph");
    await writeExecutable(binaryPath);
    vi.stubEnv("PATH", join(home, "bin"));
    await mkdir(join(repo, ".code-review-graph"));

    await crgPlugin.verify(context);

    const probe = calls.find(([, args]) => args[0] === "--version");
    const status = calls.find(([, args]) => args[0] === "status");
    for (const call of [probe, status]) {
      expect(call?.[0]).toBe(binaryPath);
      expect(call?.[2]?.env).toMatchObject({
        CRG_HOME: join(home, ".code-review-graph"),
        CRG_DATA_DIR: "",
        GIT_CONFIG_PARAMETERS: "",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_KEY_1: "core.hooksPath",
      });
    }
  });

  it("strips terminal control characters from a failing status message", async () => {
    const { context, run, home, repo } = await createTestContext();
    await writeExecutable(join(home, "bin", "code-review-graph"));
    vi.stubEnv("PATH", join(home, "bin"));
    await mkdir(join(repo, ".code-review-graph"));
    run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "code-review-graph 2.3.9\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "bad \u001b[31mred" },
    );

    const verification = await crgPlugin.verify(context);

    expect(verification).toEqual({
      ok: false,
      detail: "code-review-graph status failed: bad red",
    });
  });

  it("nuke stops the daemon before removing the graph", async () => {
    const { context, repo } = await createTestContext();
    await crgPlugin.install(context);
    await context.manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: "/fake/agemon-crg-daemon-repo.service",
      preExisting: false,
    });
    const graphPresentAtUnregister: boolean[] = [];
    const nukeContext = {
      ...context,
      yes: true,
      serviceManager: {
        async isActive() {
          return { active: true, failed: false };
        },
        async isSandboxEnforced() {
          return false;
        },
        async registerAutostart() {
          throw new Error("not used");
        },
        async unregisterAutostart() {
          graphPresentAtUnregister.push(
            existsSync(join(repo, ".code-review-graph")),
          );
          return { lingerKeptFor: null };
        },
        async readUnitWorkingDirectory() {
          return repo;
        },
      },
    } as unknown as Context;

    await uninstallPlugins(nukeContext, [crgPlugin, daemonPlugin], {});

    expect(graphPresentAtUnregister).toEqual([true]);
    expect(existsSync(join(repo, ".code-review-graph"))).toBe(false);
  });
});

describe("crg plugin — detection and state", () => {
  it("detect writes nothing to the ledger", async () => {
    const { context, home } = await createTestContext();
    const binDirectory = join(home, "bin");
    await writeExecutable(join(binDirectory, "code-review-graph"));
    vi.stubEnv("PATH", binDirectory);

    const presence = await crgPlugin.detect(context);

    expect(presence).toEqual({ present: true, preExisting: true });
    expect(context.manifest.getActions()).toEqual([]);
  });

  it("shows the pipx version, and the binary path for a PATH install", async () => {
    const pipxSetup = await createTestContext();
    await createPipxVenv(pipxSetup.pipxHome);
    vi.stubEnv(
      "PATH",
      join(pipxSetup.pipxHome, "venvs", "code-review-graph", "bin"),
    );
    const [pipxRow] =
      (await crgPlugin.describeState?.(pipxSetup.context)) ?? [];
    expect(pipxRow).toMatchObject({
      state: "present-adopted",
      detail: "pipx 2.3.9; dependencies not hash-locked",
    });

    const pathSetup = await createTestContext();
    const binaryPath = join(pathSetup.home, "bin", "code-review-graph");
    await writeExecutable(binaryPath);
    vi.stubEnv("PATH", join(pathSetup.home, "bin"));
    const [pathRow] =
      (await crgPlugin.describeState?.(pathSetup.context)) ?? [];
    expect(pathRow).toMatchObject({
      state: "present-adopted",
      detail: `${binaryPath} 2.3.9; dependencies not hash-locked`,
    });
  });

  it("reports pipx-installed-but-not-on-PATH once with 'pipx ensurepath' and proposes no install", async () => {
    const { context, infos, pipxHome } = await createTestContext();
    await createPipxVenv(pipxHome);

    const operations = await crgPlugin.plan?.(context);
    const [row] = (await crgPlugin.describeState?.(context)) ?? [];

    expect(operations?.map((operation) => operation.action)).toEqual([
      "use-shared",
    ]);
    expect(
      infos.filter((line) => line.includes("pipx ensurepath")),
    ).toHaveLength(1);
    expect(row?.detail).toBe(
      "pipx 2.3.9; dependencies not hash-locked; not on PATH — run 'pipx ensurepath' and open a new shell",
    );
    expect(await crgPlugin.detect(context)).toMatchObject({ present: true });
  });

  it("broken pipx venv is reported, not reinstalled", async () => {
    const { context, infos, pipxHome, calls } = await createTestContext();
    await createPipxVenv(pipxHome, { withPython: false });

    const operations = await crgPlugin.plan?.(context);
    const [row] = (await crgPlugin.describeState?.(context)) ?? [];
    const verification = await crgPlugin.verify(context);

    expect(operations).toEqual([]);
    expect(await crgPlugin.detect(context)).toMatchObject({ present: true });
    expect(infos).toContain(
      "pipx venv is broken — run 'pipx uninstall code-review-graph', then 'agemon'",
    );
    expect(row).toMatchObject({
      state: "unknown",
      detail:
        "pipx venv is broken — run 'pipx uninstall code-review-graph', then 'agemon'",
    });
    expect(verification.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("crg plugin — hash-lock attention", () => {
  it("needs no attention after agemon's own hash-locked install", async () => {
    const { context } = await createTestContext();
    await crgPlugin.install(context);

    const verification = await crgPlugin.verify(context);

    expect(verification.ok).toBe(true);
    expect(verification.attention).toBeUndefined();
  });

  describe("untrusted repository git config", () => {
    const UNTRUSTED: GitConfigGuardResult = {
      kind: "pairs",
      pairs: [".git/config: diff.x.command=/tmp/differ"],
      fingerprint: "e".repeat(64),
    };

    function guardReturning(
      planned: GitConfigGuardResult,
      recheck: GitConfigGuardResult = planned,
    ): GitConfigGuard {
      return { planned: async () => planned, recheck: async () => recheck };
    }

    it("marks crg's install operation with the untrusted keys", async () => {
      const { context } = await createTestContext();
      context.gitConfigGuard = guardReturning(UNTRUSTED);

      const [operation] = await (crgPlugin.plan?.(context) ?? []);

      expect(operation.untrustedGitConfig).toEqual(UNTRUSTED);
    });

    it("prints why it could not read the config and marks the operation unreadable", async () => {
      const { context, infos } = await createTestContext();
      context.gitConfigGuard = guardReturning({
        kind: "unreadable",
        category: "git-failed",
        detail: "fatal: bad config line 1",
      });

      const [operation] = await (crgPlugin.plan?.(context) ?? []);

      expect(operation.untrustedGitConfig).toEqual({
        kind: "unreadable",
        category: "git-failed",
      });
      expect(infos).toContain(
        "could not read this repository's git config: fatal: bad config line 1",
      );
    });

    it("refuses the build when the config changed after a clean plan", async () => {
      const { context, calls } = await createTestContext();
      context.gitConfigGuard = guardReturning({ kind: "clean" }, UNTRUSTED);
      const operations = (await crgPlugin.plan?.(context)) ?? [];

      await expect(crgPlugin.apply?.(context, operations)).rejects.toThrow(
        "this repository's git config changed since the plan",
      );
      expect(calls.some(([, args]) => args[0] === "build")).toBe(false);
    });

    it("builds when the approved set is unchanged at apply", async () => {
      const { context, calls } = await createTestContext();
      context.gitConfigGuard = guardReturning(UNTRUSTED);
      const operations = (await crgPlugin.plan?.(context)) ?? [];

      await crgPlugin.apply?.(context, operations);

      expect(calls.some(([, args]) => args[0] === "build")).toBe(true);
    });

    it("refuses the build when the approved set changed between plan and apply", async () => {
      const { context, calls } = await createTestContext();
      context.gitConfigGuard = guardReturning(UNTRUSTED, {
        ...UNTRUSTED,
        fingerprint: "0".repeat(64),
      } as GitConfigGuardResult);
      const operations = (await crgPlugin.plan?.(context)) ?? [];

      await expect(crgPlugin.apply?.(context, operations)).rejects.toThrow(
        "this repository's git config changed since the plan",
      );
      expect(calls.some(([, args]) => args[0] === "build")).toBe(false);
    });

    it("verifies with attention listing the keys and runs no code-review-graph status", async () => {
      const { context, calls } = await createTestContext();
      await crgPlugin.install(context);
      context.gitConfigGuard = guardReturning(UNTRUSTED);
      calls.length = 0;

      const verification = await crgPlugin.verify(context);

      expect(verification).toMatchObject({ ok: true });
      expect(verification.attention).toBe(
        "this repository's git config has keys agemon does not trust by default: .git/config: diff.x.command=/tmp/differ; code-review-graph runs git here. Remove them, or run 'agemon nuke --only crg' and then 'agemon --only crg' interactively to review them in the trust gate.",
      );
      expect(calls.some(([, args]) => args[0] === "status")).toBe(false);
    });

    it("shows the hash-lock and the git config attention together", async () => {
      const { context, pipxHome } = await createTestContext();
      await crgPlugin.install(context);
      await createPipxVenv(pipxHome, { pipArgs: [] });
      context.gitConfigGuard = guardReturning(UNTRUSTED);

      const { attention } = await crgPlugin.verify(context);

      expect(attention).toMatch(
        /not hash-locked.*; this repository's git config has keys/,
      );
    });

    it("fails verification when the config cannot be read", async () => {
      const { context } = await createTestContext();
      await crgPlugin.install(context);
      context.gitConfigGuard = guardReturning({
        kind: "unreadable",
        category: "truncated",
        detail: "git config output exceeded the capture limit",
      });

      expect(await crgPlugin.verify(context)).toEqual({
        ok: false,
        detail:
          "could not read this repository's git config: git config output exceeded the capture limit",
      });
    });
  });

  it("asks an agemon-installed crg without hash locking to be reinstalled through pipx", async () => {
    const { context, pipxHome } = await createTestContext();
    await crgPlugin.install(context);
    await createPipxVenv(pipxHome, { pipArgs: [] });

    const verification = await crgPlugin.verify(context);

    expect(verification.ok).toBe(true);
    expect(verification.attention).toBe(
      "code-review-graph's dependencies are not hash-locked (installed by an older agemon, by hand, or rewritten by 'pipx upgrade'); reinstall it: pipx uninstall code-review-graph, then run agemon",
    );
  });

  it("gives a PATH-only copy agemon recorded as installed advice that does not mention pipx uninstall", async () => {
    const { context, home } = await createTestContext();
    await context.manifest.recordAction({
      plugin: "crg",
      type: "installed-binary",
      target: "code-review-graph (pipx)",
      preExisting: false,
    });
    await writeExecutable(join(home, "bin", "code-review-graph"));
    vi.stubEnv("PATH", join(home, "bin"));

    const verification = await crgPlugin.verify(context);

    expect(verification.attention).toContain("is not a pipx install");
    expect(verification.attention).not.toContain("pipx uninstall");
  });

  it("only notes an adopted crg without hash locking", async () => {
    const { context, pipxHome } = await createTestContext();
    await createPipxVenv(pipxHome);

    expect((await crgPlugin.verify(context)).attention).toBeUndefined();
    const [row] = (await crgPlugin.describeState?.(context)) ?? [];
    expect(row?.detail).toContain("dependencies not hash-locked");
  });
});

describe("crg plugin — nuke removes the graph agemon built", () => {
  async function installedContext(options: { dryRun?: boolean } = {}) {
    const setup = await createTestContext();
    await crgPlugin.install(setup.context);
    (setup.context as { dryRun: boolean }).dryRun = options.dryRun ?? false;
    return setup;
  }

  it("removes .code-review-graph when agemon built it and it is a real directory", async () => {
    const { context, repo } = await installedContext();
    await writeFile(join(repo, ".code-review-graph", "graph.db"), "x");

    await crgPlugin.uninstall(context);

    expect(existsSync(join(repo, ".code-review-graph"))).toBe(false);
  });

  it("keeps .code-review-graph that existed before agemon built it", async () => {
    const { context, repo } = await createTestContext();
    await mkdir(join(repo, ".code-review-graph"));
    await crgPlugin.install(context);

    await crgPlugin.uninstall(context);

    expect(existsSync(join(repo, ".code-review-graph"))).toBe(true);
  });

  it("removes the graph even when crg itself was pre-existing", async () => {
    const { context, repo } = await createTestContext();
    await context.manifest.recordAction({
      plugin: "crg",
      type: "graph-built",
      target: ".code-review-graph",
      preExisting: false,
    });
    await mkdir(join(repo, ".code-review-graph"));

    await crgPlugin.uninstall(context);

    expect(existsSync(join(repo, ".code-review-graph"))).toBe(false);
  });

  it("nuke leaves a .code-review-graph symlink alone and reports it", async () => {
    const { context, repo, home, infos } = await installedContext();
    await rm(join(repo, ".code-review-graph"), { recursive: true });
    const elsewhere = join(home, "graph-elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await symlink(elsewhere, join(repo, ".code-review-graph"));

    await crgPlugin.uninstall(context);

    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
    expect(infos.some((line) => line.includes("left .code-review-graph"))).toBe(
      true,
    );
  });

  it("reports a missing graph directory without failing", async () => {
    const { context, repo, infos } = await installedContext();
    await rm(join(repo, ".code-review-graph"), { recursive: true });

    await crgPlugin.uninstall(context);

    expect(infos).toContain(
      "no .code-review-graph in the repository; a graph kept elsewhere by crg's registry is not removed",
    );
  });

  it("nuke preview names what the graph holds", async () => {
    const { context, repo, infos } = await installedContext({ dryRun: true });

    await crgPlugin.uninstall(context);

    expect(infos).toContain(
      "Would remove .code-review-graph/ (code graph, wiki/exports, embeddings — rebuildable with code-review-graph build)",
    );
    expect(existsSync(join(repo, ".code-review-graph"))).toBe(true);
  });
});

describe("crg plugin — hash-locked install", () => {
  it("copies the constraints to a content-addressed file under the state root and reuses it", async () => {
    const { context, toolsRoot } = await createTestContext();
    const copyPath = await shippedConstraintsCopyPath(toolsRoot);

    await crgPlugin.install(context);
    const firstCopy = await stat(copyPath);
    await crgPlugin.install(context);

    await expect(readFile(copyPath, "utf8")).resolves.toBe(
      await readFile(SHIPPED_CONSTRAINTS, "utf8"),
    );
    expect((await stat(copyPath)).ino).toBe(firstCopy.ino);
    expect((await stat(toolsRoot)).mode & 0o777).toBe(0o700);
  });

  it("replaces a constraints copy whose content differs", async () => {
    const { context, toolsRoot } = await createTestContext();
    const copyPath = await shippedConstraintsCopyPath(toolsRoot);
    await mkdir(toolsRoot, { recursive: true });
    await writeFile(copyPath, "requests==1.0\n", "utf8");

    await crgPlugin.install(context);

    await expect(readFile(copyPath, "utf8")).resolves.toBe(
      await readFile(SHIPPED_CONSTRAINTS, "utf8"),
    );
  });

  it("refuses a constraints copy that is a symlink", async () => {
    const { context, toolsRoot, calls } = await createTestContext();
    const copyPath = await shippedConstraintsCopyPath(toolsRoot);
    await mkdir(toolsRoot, { recursive: true });
    await symlink(SHIPPED_CONSTRAINTS, copyPath);

    await expect(crgPlugin.install(context)).rejects.toThrow(copyPath);
    expect(calls).toEqual([]);
  });

  it("dry-run does not write the constraints copy", async () => {
    const { context, toolsRoot } = await createTestContext({ dryRun: true });

    await crgPlugin.install(context);

    expect(existsSync(toolsRoot)).toBe(false);
  });

  it("surfaces pipx's hash-mismatch stderr without terminal control characters", async () => {
    const { context, run } = await createTestContext();
    run.mockImplementation(async () => ({
      code: 1,
      stdout: "",
      stderr:
        "\u001b]0;title\u0007ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.",
    }));

    await expect(crgPlugin.install(context)).rejects.toThrow(
      "?]0;title?ERROR: THESE PACKAGES DO NOT MATCH THE HASHES",
    );
  });

  it("quotes a constraints path with spaces, quotes and newlines for pipx", () => {
    expect(hashLockedPipArgs("/home/a b/it's\nhere/c.txt")).toBe(
      "--pip-args=--require-hashes --only-binary=:all: -c '/home/a b/it'\\''s\nhere/c.txt'",
    );
  });

  it("shipped constraints pin exactly the crg version and hash every requirement", async () => {
    const lines = (await readFile(SHIPPED_CONSTRAINTS, "utf8"))
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    const requirement =
      /^[a-z0-9][a-z0-9._-]*==[0-9][0-9a-z.+!-]*( ; [^\\]+)? \\$/;
    const hash = /^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/;

    const requirements: string[] = [];
    let hashesForCurrent = 0;
    for (const line of lines) {
      if (requirement.test(line)) {
        expect(requirements.length === 0 || hashesForCurrent > 0).toBe(true);
        requirements.push(line.split(" ")[0]);
        hashesForCurrent = 0;
      } else {
        expect(line).toMatch(hash);
        hashesForCurrent += 1;
      }
    }
    expect(hashesForCurrent).toBeGreaterThan(0);
    expect(requirements).toContain(PINNED_SPEC);
    expect(
      requirements.filter((name) => name.startsWith("code-review-graph==")),
    ).toEqual([PINNED_SPEC]);
  });
});

describe("crg plugin — shared with other repositories", () => {
  it("plan proposes use-shared while this repository is not a holder, and nothing once it holds", async () => {
    const { context, pipxHome } = await createTestContext();
    await createPipxVenv(pipxHome);

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    expect(operation).toMatchObject({
      action: "use-shared",
      targetPath: "pipx:code-review-graph",
      riskClass: "inert",
      requiresConsent: false,
    });
    await crgPlugin.apply?.(context, [operation]);

    expect(await crgPlugin.plan?.(context)).toEqual([]);
    expect(context.manifest.getActions().map((entry) => entry.type)).toEqual([
      "uses-shared-resource",
    ]);
  });

  it("rolling back a use-shared op drops the holder and never uninstalls", async () => {
    const { context, pipxHome, calls } = await createTestContext();
    await createPipxVenv(pipxHome);
    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    await crgPlugin.apply?.(context, [operation]);

    await crgPlugin.revert?.(context, context.manifest.getActions());

    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
    const [again] = (await crgPlugin.plan?.(context)) ?? [];
    expect(again?.action).toBe("use-shared");
  });

  it("verifies a use-shared-only repository without a graph without running status", async () => {
    const { context, pipxHome, calls, repo } = await createTestContext();
    await createPipxVenv(pipxHome);
    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    await crgPlugin.apply?.(context, [operation]);

    expect(await crgPlugin.verify(context)).toEqual({
      ok: true,
      detail: "installed; no graph built in this repository",
    });
    expect(calls.some(([, args]) => args[0] === "status")).toBe(false);
    expect(existsSync(join(repo, ".code-review-graph"))).toBe(false);
  });

  it("crash after the repo entry, before the machine holder: plan proposes use-shared again and nuke removes nothing", async () => {
    const { context, pipxHome, calls } = await createTestContext();
    await createPipxVenv(pipxHome);
    await context.manifest.recordAction({
      plugin: "crg",
      type: "uses-shared-resource",
      target: "code-review-graph",
      resourceId: "shared:pipx:code-review-graph",
      preExisting: true,
    });

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    expect(operation?.action).toBe("use-shared");
    await crgPlugin.uninstall(context);
    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
  });

  it("machine holder without a repo entry: status flags it and plan proposes use-shared", async () => {
    const { context, pipxHome } = await createTestContext();
    await createPipxVenv(pipxHome);
    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    await crgPlugin.apply?.(context, [operation]);
    await context.manifest.removeActionsForPlugin("crg");

    const [row] = await describeSharedTools(context, [crgPlugin]);
    expect(row?.heldWithoutLedgerEntry).toBe(true);
    const [again] = (await crgPlugin.plan?.(context)) ?? [];
    expect(again?.action).toBe("use-shared");
  });

  it("verify fails when a graph agemon built has gone missing", async () => {
    const { context, repo } = await createTestContext();
    await crgPlugin.install(context);
    await rm(join(repo, ".code-review-graph"), { recursive: true });

    expect(await crgPlugin.verify(context)).toEqual({
      ok: false,
      detail: ".code-review-graph/ is missing — run agemon to build it again",
    });
  });

  it("a use-shared op applied after crg disappeared installs nothing", async () => {
    const { context, pipxHome, calls } = await createTestContext();
    await createPipxVenv(pipxHome);
    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    await rm(join(pipxHome, "venvs"), { recursive: true });

    await expect(crgPlugin.apply?.(context, [operation])).rejects.toThrow(
      "code-review-graph is no longer installed — re-run 'agemon plan'.",
    );
    expect(calls.some(([command]) => command === "pipx")).toBe(false);
  });

  it("a pre-P8 ledger that installed crg proposes use-shared with the claim, and nuke keeps crg", async () => {
    const { context, pipxHome, calls, infos } = await createTestContext();
    await createPipxVenv(pipxHome);
    await context.manifest.recordAction({
      plugin: "crg",
      type: "installed-binary",
      target: "code-review-graph (pipx)",
      preExisting: false,
    });

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    expect(operation?.preview.text).toContain(
      "this repository's ledger says agemon installed it",
    );
    await crgPlugin.apply?.(context, [operation]);
    await crgPlugin.uninstall(context);

    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
    expect(infos.at(-1)).toContain(
      "Run 'pipx uninstall code-review-graph' yourself",
    );
  });

  it("an unconfirmed install claim in a fresh clone records crg as pre-existing, so --remove-shared removes nothing", async () => {
    const { context, pipxHome, calls, infos } = await createTestContext();
    await createPipxVenv(pipxHome);
    await appendLedgerClaims(context, [
      {
        plugin: "crg",
        type: "installed-binary",
        target: "code-review-graph (pipx)",
        preExisting: false,
      },
    ]);

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];
    expect(operation?.preview.text).toBe(
      "record that this repository uses code-review-graph",
    );
    await crgPlugin.apply?.(context, [operation]);
    expect(
      (await readMachineLedger()).resources["pipx:code-review-graph"],
    ).toMatchObject({ origin: "pre-existing" });
    await crgPlugin.uninstall({
      ...context,
      removeSharedTools: new Set(["code-review-graph"]),
    } as Context);

    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
    expect(infos.at(-1)).toBe(
      "Keeping code-review-graph: agemon has no record on this machine that it installed it from this repository — run 'pipx uninstall code-review-graph' yourself if nothing else needs it",
    );
  });

  it("a migrated record claimed by this repository is kept on nuke --remove-shared when its install entry is unconfirmed", async () => {
    const { context, repo, pipxHome, calls, infos } = await createTestContext();
    await createPipxVenv(pipxHome);
    await writeFile(
      join((await resolveAgemonStateDirectory("prepare")).path, "machine.json"),
      JSON.stringify({
        version: 1,
        resources: {
          "pipx:code-review-graph": {
            origin: "migrated",
            claimedBy: repo,
            ownerDirectoryId: await directoryIdentity(repo),
            holders: [repo],
          },
        },
      }),
      { mode: 0o600 },
    );
    await appendLedgerClaims(context, [
      {
        plugin: "crg",
        type: "installed-binary",
        target: "code-review-graph (pipx)",
        preExisting: false,
      },
    ]);

    await crgPlugin.uninstall({
      ...context,
      removeSharedTools: new Set(["code-review-graph"]),
    } as Context);

    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
    expect(infos.at(-1)).toBe(
      "Keeping code-review-graph: the shared-tools ledger names this repository as its installer, but this repository's ledger entry for that install is not confirmed (written before ledger receipts, or not on this machine) — run 'pipx uninstall code-review-graph' yourself if nothing else needs it",
    );
  });

  it("verify gives no rebuild advice for a missing graph named only by an unconfirmed entry", async () => {
    const { context, pipxHome } = await createTestContext();
    await createPipxVenv(pipxHome);
    await appendLedgerClaims(context, [
      {
        plugin: "crg",
        type: "graph-built",
        target: ".code-review-graph",
        preExisting: false,
      },
    ]);

    expect(await crgPlugin.verify(context)).toMatchObject({
      ok: true,
      detail: "installed; no graph built in this repository",
    });
  });

  it("nuke keeps a .code-review-graph named only by an unconfirmed entry", async () => {
    const { context, repo, infos } = await createTestContext();
    await mkdir(join(repo, ".code-review-graph"));
    await appendLedgerClaims(context, [
      {
        plugin: "crg",
        type: "graph-built",
        target: ".code-review-graph",
        preExisting: false,
      },
    ]);

    await crgPlugin.uninstall(context);

    expect(existsSync(join(repo, ".code-review-graph"))).toBe(true);
    expect(infos).toContain(
      "Keeping .code-review-graph/: agemon has no record on this machine that it built it here",
    );
  });

  it("a forged ledger in a fresh clone removes nothing on nuke", async () => {
    const { context, pipxHome, calls } = await createTestContext();
    await createPipxVenv(pipxHome);
    await context.manifest.recordAction({
      plugin: "crg",
      type: "installed-binary",
      target: "code-review-graph (pipx)",
      preExisting: false,
    });

    await crgPlugin.uninstall({
      ...context,
      removeSharedTools: new Set(["code-review-graph"]),
    } as Context);

    expect(
      calls.some(
        ([command, args]) => command === "pipx" && args[0] === "uninstall",
      ),
    ).toBe(false);
  });
});
