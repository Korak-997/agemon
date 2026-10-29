import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import {
  resetFakeSubprocessState,
  runFakeSubprocess,
} from "../../../src/core/fake-subprocess.js";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import {
  locateCodeReviewGraph,
  resolvePipxHome,
} from "../../../src/plugins/crg/locate.js";
import { CODE_REVIEW_GRAPH_PACKAGE_SPEC } from "../../../src/plugins/pins.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const METADATA_FIXTURE = join(
  process.cwd(),
  "test/unit/plugins/fixtures/pipx_metadata.json",
);
const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetFakeSubprocessState();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface Sandbox {
  home: string;
  repo: string;
  defaultPipxHome: string;
}

async function createSandbox(): Promise<Sandbox> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-crg-locate-")),
  );
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
  return {
    home,
    repo,
    defaultPipxHome: join(home, ".local", "share", "pipx"),
  };
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
}

interface VenvOptions {
  appPath?: (venv: string) => string;
  packageName?: string;
  packageVersion?: string;
  withPython?: boolean;
  pipArgs?: unknown;
}

async function createPipxVenv(
  pipxHome: string,
  options: VenvOptions = {},
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
  if (options.appPath) {
    metadata.main_package.app_paths[0].__Path__ = options.appPath(venv);
  }
  if (options.packageName !== undefined) {
    metadata.main_package.package = options.packageName;
  }
  if (options.packageVersion !== undefined) {
    metadata.main_package.package_version = options.packageVersion;
  }
  if (options.pipArgs !== undefined) {
    metadata.main_package.pip_args = options.pipArgs;
  }
  await writeFile(
    join(venv, "pipx_metadata.json"),
    JSON.stringify(metadata),
    "utf8",
  );
  return binaryPath;
}

function createRun(versionOutput = "code-review-graph 2.3.9\n") {
  return vi.fn(
    async (command: string): Promise<SubprocessResult> =>
      command.endsWith("code-review-graph")
        ? { code: 0, stdout: versionOutput, stderr: "" }
        : { code: 127, stdout: "", stderr: "not found" },
  );
}

function contextFor(repo: string, run = createRun()) {
  return {
    context: {
      cwd: repo,
      run,
      platform: LINUX_TEST_PLATFORM,
    } as unknown as Context,
    run,
  };
}

describe("locateCodeReviewGraph — pipx metadata", () => {
  it("locator reads pipx_metadata.json and never spawns pipx", async () => {
    const sandbox = await createSandbox();
    const binaryPath = await createPipxVenv(sandbox.defaultPipxHome);
    const { context, run } = contextFor(sandbox.repo);

    const location = await locateCodeReviewGraph(context);

    expect(location).toEqual({
      status: "found",
      source: "pipx",
      binaryPath,
      version: "2.3.9",
      onPath: false,
      hashLocked: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports onPath when a PATH entry leads to the pipx binary", async () => {
    const sandbox = await createSandbox();
    const binaryPath = await createPipxVenv(sandbox.defaultPipxHome);
    const localBin = join(sandbox.home, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    await symlink(binaryPath, join(localBin, "code-review-graph"));
    vi.stubEnv("PATH", localBin);

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toMatchObject({ source: "pipx", onPath: true });
  });

  it.each([
    ["a relative app path", { appPath: () => "bin/code-review-graph" }],
    [
      "a misnamed app path",
      { appPath: (venv: string) => join(venv, "bin", "fastmcp") },
    ],
    [
      "an app path with a control character",
      { appPath: (venv: string) => join(venv, "bin", "code-review-graph\n") },
    ],
    ["another package", { packageName: "not-crg" }],
    ["an invalid version", { packageVersion: "2.3.9; rm -rf /" }],
  ])("rejects a pipx venv with %s", async (_label, options) => {
    const sandbox = await createSandbox();
    await createPipxVenv(sandbox.defaultPipxHome, options);

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("app path outside the venv is refused", async () => {
    const sandbox = await createSandbox();
    const outside = join(sandbox.home, "elsewhere", "code-review-graph");
    await writeExecutable(outside);
    await createPipxVenv(sandbox.defaultPipxHome, { appPath: () => outside });

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("metadata symlink is refused", async () => {
    const sandbox = await createSandbox();
    await createPipxVenv(sandbox.defaultPipxHome);
    const venv = join(sandbox.defaultPipxHome, "venvs", "code-review-graph");
    const realMetadata = join(sandbox.home, "metadata.json");
    await writeFile(
      realMetadata,
      await readFile(join(venv, "pipx_metadata.json"), "utf8"),
    );
    await rm(join(venv, "pipx_metadata.json"));
    await symlink(realMetadata, join(venv, "pipx_metadata.json"));

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("broken pipx venv is reported", async () => {
    const sandbox = await createSandbox();
    await createPipxVenv(sandbox.defaultPipxHome, { withPython: false });

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "broken-venv" });
  });

  it("refuses a pipx binary inside the repository", async () => {
    const sandbox = await createSandbox();
    vi.stubEnv("PIPX_HOME", join(sandbox.repo, "pipx"));
    await createPipxVenv(join(sandbox.repo, "pipx"));

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("repo at $HOME locates the pipx crg and converges", async () => {
    const sandbox = await createSandbox();
    const binaryPath = await createPipxVenv(sandbox.defaultPipxHome);
    const localBin = join(sandbox.home, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    await symlink(binaryPath, join(localBin, "code-review-graph"));
    vi.stubEnv("PATH", localBin);

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.home).context,
    );

    expect(location).toEqual({
      status: "found",
      source: "pipx",
      binaryPath,
      version: "2.3.9",
      onPath: true,
      hashLocked: false,
    });
  });
});

describe("locateCodeReviewGraph — hash lock", () => {
  function agemonPipArgs(constraintsPath: string): string[] {
    return ["--require-hashes", "--only-binary=:all:", "-c", constraintsPath];
  }

  function toolsRoot(): string {
    return join(process.env.XDG_STATE_HOME ?? "", "agemon", "tools");
  }

  it("is hash-locked only for the exact pip_args agemon writes", async () => {
    const sandbox = await createSandbox();
    await createPipxVenv(sandbox.defaultPipxHome, {
      pipArgs: agemonPipArgs(
        join(toolsRoot(), "code-review-graph-constraints-0123456789abcdef.txt"),
      ),
    });

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toMatchObject({ status: "found", hashLocked: true });
  });

  it.each([
    ["no pip_args", []],
    ["a string instead of a list", "--require-hashes"],
    [
      "an extra package source",
      [
        ...["--require-hashes", "--only-binary=:all:", "-c"],
        "/tmp/x.txt",
        "--extra-index-url=https://evil",
      ],
    ],
    [
      "a constraints file outside the tools dir",
      [
        "--require-hashes",
        "--only-binary=:all:",
        "-c",
        "/tmp/code-review-graph-constraints-0123456789abcdef.txt",
      ],
    ],
    ["a path that climbs out of the tools dir", null],
  ])("is not hash-locked with %s", async (_label, pipArgs) => {
    const sandbox = await createSandbox();
    await createPipxVenv(sandbox.defaultPipxHome, {
      pipArgs:
        pipArgs ??
        agemonPipArgs(
          `${toolsRoot()}/../tools/code-review-graph-constraints-0123456789abcdef.txt`,
        ),
    });

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toMatchObject({ status: "found", hashLocked: false });
  });
});

describe("resolvePipxHome", () => {
  it("uses PIPX_HOME when it is set", async () => {
    const sandbox = await createSandbox();
    vi.stubEnv("PIPX_HOME", join(sandbox.home, "custom-pipx"));

    expect(await resolvePipxHome("linux")).toBe(
      join(sandbox.home, "custom-pipx"),
    );
  });

  it("prefers the legacy ~/.local/pipx when it exists", async () => {
    const sandbox = await createSandbox();
    await mkdir(join(sandbox.home, ".local", "pipx"), { recursive: true });
    vi.stubEnv("XDG_DATA_HOME", join(sandbox.home, "xdg"));

    expect(await resolvePipxHome("linux")).toBe(
      join(sandbox.home, ".local", "pipx"),
    );
  });

  it("uses $XDG_DATA_HOME/pipx when XDG_DATA_HOME is absolute", async () => {
    const sandbox = await createSandbox();
    vi.stubEnv("XDG_DATA_HOME", join(sandbox.home, "xdg"));

    expect(await resolvePipxHome("linux")).toBe(
      join(sandbox.home, "xdg", "pipx"),
    );
  });

  it("falls back to ~/.local/share/pipx", async () => {
    const sandbox = await createSandbox();
    vi.stubEnv("XDG_DATA_HOME", "relative/xdg");

    expect(await resolvePipxHome("linux")).toBe(sandbox.defaultPipxHome);
  });

  it("uses ~/Library/Application Support/pipx on darwin, ignoring XDG_DATA_HOME", async () => {
    const sandbox = await createSandbox();
    vi.stubEnv("XDG_DATA_HOME", join(sandbox.home, "xdg"));

    expect(await resolvePipxHome("darwin")).toBe(
      join(sandbox.home, "Library", "Application Support", "pipx"),
    );
  });

  it("prefers the legacy ~/.local/pipx on darwin when it exists", async () => {
    const sandbox = await createSandbox();
    await mkdir(join(sandbox.home, ".local", "pipx"), { recursive: true });

    expect(await resolvePipxHome("darwin")).toBe(
      join(sandbox.home, ".local", "pipx"),
    );
  });

  it.each([
    ["relative", "pipx-home"],
    ["empty", ""],
    ["with a control character", "/tmp/pipx\nhome"],
    ["with edge whitespace", " /tmp/pipx"],
  ])("invalid PIPX_HOME (%s) is refused", async (_label, value) => {
    await createSandbox();
    vi.stubEnv("PIPX_HOME", value);

    await expect(resolvePipxHome("linux")).rejects.toThrow(/PIPX_HOME/);
  });
});

describe("locateCodeReviewGraph — PATH fallback", () => {
  it("falls back to code-review-graph on PATH when pipx has no such venv", async () => {
    const sandbox = await createSandbox();
    const binDirectory = join(sandbox.home, "bin");
    await writeExecutable(join(binDirectory, "code-review-graph"));
    vi.stubEnv("PATH", binDirectory);
    const { context, run } = contextFor(sandbox.repo);

    const location = await locateCodeReviewGraph(context);

    expect(location).toEqual({
      status: "found",
      source: "path",
      binaryPath: join(binDirectory, "code-review-graph"),
      version: "2.3.9",
      onPath: true,
      hashLocked: false,
    });
    expect(run).toHaveBeenCalledWith(
      join(binDirectory, "code-review-graph"),
      ["--version"],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_CONFIG_PARAMETERS: "" }),
      }),
    );
  });

  it("treats a PATH binary whose --version fails as absent", async () => {
    const sandbox = await createSandbox();
    const binDirectory = join(sandbox.home, "bin");
    await writeExecutable(join(binDirectory, "code-review-graph"));
    vi.stubEnv("PATH", binDirectory);
    const run = vi.fn(
      async (): Promise<SubprocessResult> => ({
        code: 1,
        stdout: "",
        stderr: "boom",
      }),
    );

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo, run).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("PATH fallback skips <repo>/node_modules/.bin and relative entries", async () => {
    const sandbox = await createSandbox();
    const repoBin = join(sandbox.repo, "node_modules", ".bin");
    await writeExecutable(join(repoBin, "code-review-graph"));
    vi.stubEnv("PATH", [repoBin, "node_modules/.bin"].join(delimiter));
    const { context, run } = contextFor(sandbox.repo);

    const location = await locateCodeReviewGraph(context);

    expect(location).toEqual({ status: "absent" });
    expect(run).not.toHaveBeenCalled();
  });

  it("PATH fallback skips npm-injected node_modules/.bin entries outside the repository when npm launched agemon", async () => {
    const sandbox = await createSandbox();
    const npxBin = join(
      sandbox.home,
      ".npm",
      "_npx",
      "0a1b",
      "node_modules",
      ".bin",
    );
    await writeExecutable(join(npxBin, "code-review-graph"));
    vi.stubEnv("PATH", npxBin);
    vi.stubEnv("npm_command", "exec");
    const { context, run } = contextFor(sandbox.repo);

    const location = await locateCodeReviewGraph(context);

    expect(location).toEqual({ status: "absent" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a PATH binary that is a symlink into the repository", async () => {
    const sandbox = await createSandbox();
    const planted = join(sandbox.repo, "tools", "code-review-graph");
    await writeExecutable(planted);
    const binDirectory = join(sandbox.home, "bin");
    await mkdir(binDirectory, { recursive: true });
    await symlink(planted, join(binDirectory, "code-review-graph"));
    vi.stubEnv("PATH", binDirectory);
    const { context, run } = contextFor(sandbox.repo);

    const location = await locateCodeReviewGraph(context);

    expect(location).toEqual({ status: "absent" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("locateCodeReviewGraph — fake backend", () => {
  async function enterFakeMode(): Promise<Sandbox> {
    const sandbox = await createSandbox();
    vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");
    vi.stubEnv("AGEMON_FAKE_PREINSTALLED_CRG", "");
    resetFakeSubprocessState();
    return sandbox;
  }

  it("fake mode ignores a code-review-graph on the host PATH", async () => {
    const sandbox = await enterFakeMode();
    const binDirectory = join(sandbox.home, "bin");
    await writeExecutable(join(binDirectory, "code-review-graph"));
    vi.stubEnv("PATH", binDirectory);

    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toEqual({ status: "absent" });
  });

  it("fake mode leaves ~/.local/share/pipx untouched", async () => {
    const sandbox = await enterFakeMode();

    runFakeSubprocess("pipx", ["install", CODE_REVIEW_GRAPH_PACKAGE_SPEC]);
    const location = await locateCodeReviewGraph(
      contextFor(sandbox.repo).context,
    );

    expect(location).toMatchObject({
      status: "found",
      source: "pipx",
      onPath: true,
      hashLocked: false,
    });
    expect(
      (location as { binaryPath: string }).binaryPath.startsWith(
        join(sandbox.home, ".agemon", "fake-pipx"),
      ),
    ).toBe(true);
    expect(existsSync(sandbox.defaultPipxHome)).toBe(false);

    runFakeSubprocess("pipx", ["uninstall", "code-review-graph"]);
    expect(
      await locateCodeReviewGraph(contextFor(sandbox.repo).context),
    ).toEqual({ status: "absent" });
  });
});
