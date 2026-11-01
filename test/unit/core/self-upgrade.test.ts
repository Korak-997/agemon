import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallMethod } from "../../../src/core/install-method.js";

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));
const prompt = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn(() => true),
  promptYesNo: vi.fn(async () => true),
}));
const fsPromises = vi.hoisted(() => ({ failRenameCall: 0 }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: childProcess.execFileSync,
}));
vi.mock("../../../src/core/prompt.js", () => prompt);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  let renameCalls = 0;
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      renameCalls += 1;
      if (fsPromises.failRenameCall === renameCalls) {
        throw Object.assign(new Error("EXDEV: simulated"), { code: "EXDEV" });
      }
      return actual.rename(from, to);
    }),
    resetRenameCalls: () => {
      renameCalls = 0;
    },
  };
});
const subprocess = vi.hoisted(() => ({
  npmCalls: [] as string[][],
  ghCalls: [] as string[][],
}));
vi.mock("../../../src/core/subprocess-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/core/subprocess-runner.js")
    >();
  return {
    ...actual,
    runSubprocess: vi.fn(
      async (command: string, args: string[], options?: object) => {
        if (command === "npm") {
          subprocess.npmCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "gh") {
          subprocess.ghCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.endsWith("/bin/agemon")) {
          return { code: 0, stdout: `${TARGET_VERSION}\n`, stderr: "" };
        }
        return actual.runSubprocess(command, args, options);
      },
    ),
  };
});

const { runRollback, runUpgrade } = await import(
  "../../../src/core/self-upgrade.js"
);

const RUNNING_VERSION = "4.7.2";
const TARGET_VERSION = "4.8.0";
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/Korak-997/agemon/releases/latest";
const INSTALLER_SCRIPT = "#!/usr/bin/env sh\necho installing\n";
const TARBALL = "tarball-bytes";

const createdTempDirectories: string[] = [];
let releaseAssets: Map<string, string>;
let home: string;

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function assetUrl(version: string, name: string): string {
  return `https://github.com/Korak-997/agemon/releases/download/v${version}/${name}`;
}

function publishRelease(
  version: string,
  overrides: { installer?: string; tarball?: string; checksums?: string } = {},
): void {
  const installer = overrides.installer ?? INSTALLER_SCRIPT;
  const tarball = overrides.tarball ?? TARBALL;
  releaseAssets.set(assetUrl(version, "install.sh"), installer);
  releaseAssets.set(assetUrl(version, "agemon.tgz"), tarball);
  releaseAssets.set(
    assetUrl(version, "SHA256SUMS"),
    overrides.checksums ??
      `${sha256(TARBALL)}  agemon.tgz\n${sha256(INSTALLER_SCRIPT)}  install.sh\n`,
  );
}

function setLatestRelease(version: string | null): void {
  if (version === null) {
    releaseAssets.delete(LATEST_RELEASE_API_URL);
    return;
  }
  releaseAssets.set(
    LATEST_RELEASE_API_URL,
    JSON.stringify({ tag_name: `v${version}` }),
  );
}

async function createTempDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-self-upgrade-test-")),
  );
  createdTempDirectories.push(directory);
  return directory;
}

async function createInstallTree(directory: string, version: string) {
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "agemon", version }),
  );
  await writeFile(
    join(directory, "bin", "agemon.js"),
    `if (process.argv[2] === "--version") console.log("${version}");\n`,
  );
  await writeFile(join(directory, ".agemon-install"), `${version}\n`);
}

async function defaultInstallDirectory(): Promise<string> {
  const installDir = join(home, ".local", "share", "agemon");
  await createInstallTree(installDir, RUNNING_VERSION);
  return installDir;
}

function installedEnvironment(): Record<string, string> {
  return childProcess.execFileSync.mock.calls[0][2].env;
}

function upgrade(
  method: InstallMethod,
  options: { version?: string; print?: boolean; yes?: boolean } = {},
) {
  return runUpgrade({
    method,
    runningVersion: RUNNING_VERSION,
    version: options.version,
    print: options.print ?? false,
    yes: options.yes ?? false,
  });
}

beforeEach(async () => {
  home = await createTempDirectory();
  vi.stubEnv("HOME", home);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  releaseAssets = new Map();
  publishRelease(TARGET_VERSION);
  setLatestRelease(TARGET_VERSION);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = releaseAssets.get(url);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  childProcess.execFileSync.mockReset();
  prompt.isInteractiveTerminal.mockReturnValue(true);
  prompt.promptYesNo.mockClear();
  subprocess.npmCalls.length = 0;
  subprocess.ghCalls.length = 0;
  fsPromises.failRenameCall = 0;
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("runUpgrade through the install script", () => {
  it("runs the verified installer for the default dir without AGEMON_INSTALL_DIR", async () => {
    const installDir = await defaultInstallDirectory();
    vi.stubEnv("AGEMON_INSTALL_DIR", "/somewhere/else");

    await expect(upgrade({ kind: "install-script", installDir })).resolves.toBe(
      0,
    );

    const [command, args] = childProcess.execFileSync.mock.calls[0];
    expect(command).toBe("sh");
    expect(args).toHaveLength(1);
    expect(existsSync(dirname(args[0]))).toBe(false);
    expect(installedEnvironment().AGEMON_VERSION).toBe(TARGET_VERSION);
    expect(installedEnvironment()).not.toHaveProperty("AGEMON_INSTALL_DIR");
  });

  it("passes a custom install dir to the installer", async () => {
    const installDir = join(await createTempDirectory(), "agemon");
    await createInstallTree(installDir, RUNNING_VERSION);

    await upgrade({ kind: "install-script", installDir });

    expect(installedEnvironment().AGEMON_INSTALL_DIR).toBe(installDir);
  });

  it("still treats the default dir as default when ~/.local/share is a symlink", async () => {
    const elsewhere = await createTempDirectory();
    await mkdir(join(home, ".local"), { recursive: true });
    await createInstallTree(join(elsewhere, "agemon"), RUNNING_VERSION);
    const { symlink } = await import("node:fs/promises");
    await symlink(elsewhere, join(home, ".local", "share"));

    await upgrade({
      kind: "install-script",
      installDir: join(elsewhere, "agemon"),
    });

    expect(installedEnvironment()).not.toHaveProperty("AGEMON_INSTALL_DIR");
  });

  it("hands the installer an environment without npm's launch config", async () => {
    const installDir = await defaultInstallDirectory();
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("npm_config_registry", "https://evil.example/");
    vi.stubEnv("PATH", `/repo/node_modules/.bin:relative:${process.env.PATH}`);

    await upgrade({ kind: "install-script", installDir });

    const environment = installedEnvironment();
    expect(
      Object.keys(environment).filter((name) => /^npm_/i.test(name)),
    ).toEqual([]);
    expect(environment.PATH.split(":")).not.toContain(
      "/repo/node_modules/.bin",
    );
    expect(environment.PATH.split(":")).not.toContain("relative");
  });

  it.each([
    [
      "the checksum does not match",
      { installer: "#!/bin/sh\necho tampered\n" },
    ],
    [
      "SHA256SUMS has no install.sh line",
      { checksums: `${sha256(TARBALL)}  agemon.tgz\n` },
    ],
    [
      "SHA256SUMS lists install.sh twice",
      {
        checksums: `${sha256(INSTALLER_SCRIPT)}  install.sh\n${sha256(INSTALLER_SCRIPT)}  install.sh\n`,
      },
    ],
    [
      "the checksum is upper-case",
      { checksums: `${sha256(INSTALLER_SCRIPT).toUpperCase()}  install.sh\n` },
    ],
    [
      "install.sh exceeds the size limit",
      { installer: "x".repeat(1024 * 1024 + 1) },
    ],
  ])("runs nothing when %s", async (_label, overrides) => {
    const installDir = await defaultInstallDirectory();
    publishRelease(TARGET_VERSION, overrides);

    await expect(
      upgrade({ kind: "install-script", installDir }),
    ).rejects.toThrow();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("runs nothing when the release has no SHA256SUMS", async () => {
    const installDir = await defaultInstallDirectory();
    releaseAssets.delete(assetUrl(TARGET_VERSION, "SHA256SUMS"));

    await expect(
      upgrade({ kind: "install-script", installDir }),
    ).rejects.toThrow(/HTTP 404/);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("verifies install.sh's attestation before running it when AGEMON_VERIFY_ATTESTATION=1", async () => {
    const installDir = await defaultInstallDirectory();
    vi.stubEnv("AGEMON_VERIFY_ATTESTATION", "1");

    await upgrade({ kind: "install-script", installDir });

    expect(subprocess.ghCalls).toHaveLength(1);
    expect(subprocess.ghCalls[0].slice(0, 2)).toEqual([
      "attestation",
      "verify",
    ]);
    expect(subprocess.ghCalls[0][2]).toMatch(/install\.sh$/);
    expect(subprocess.ghCalls[0]).toContain("--deny-self-hosted-runners");
  });

  it("refuses a copy owned by another user before downloading anything", async () => {
    const installDir = await defaultInstallDirectory();
    const uid = process.geteuid?.() ?? 0;
    vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);

    await expect(
      upgrade({ kind: "install-script", installDir }),
    ).rejects.toThrow(/belongs to uid .*Run this with sudo/);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("refuses root running with a user's HOME before resolving any path", async () => {
    const installDir = await defaultInstallDirectory();
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(
      upgrade({ kind: "install-script", installDir }),
    ).rejects.toThrow(/another user's environment.*not 'sudo -E'/);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});

describe("runUpgrade version selection", () => {
  it("reports up to date when the latest release is the running one", async () => {
    const installDir = await defaultInstallDirectory();
    setLatestRelease(RUNNING_VERSION);

    await expect(upgrade({ kind: "install-script", installDir })).resolves.toBe(
      0,
    );
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("never downgrades on its own when the latest release is older", async () => {
    const installDir = await defaultInstallDirectory();
    setLatestRelease("4.7.1");

    await expect(upgrade({ kind: "install-script", installDir })).resolves.toBe(
      0,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("up to date"),
    );
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("previews an explicit downgrade without a terminal or --yes", async () => {
    const installDir = await defaultInstallDirectory();
    prompt.isInteractiveTerminal.mockReturnValue(false);
    publishRelease("4.6.0");

    await expect(
      upgrade({ kind: "install-script", installDir }, { version: "4.6.0" }),
    ).resolves.toBe(0);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("runs the newest installer for a downgrade, with the older version as target", async () => {
    const installDir = await defaultInstallDirectory();
    publishRelease("4.6.0", { installer: "#!/bin/sh\necho old installer\n" });

    await upgrade(
      { kind: "install-script", installDir },
      { version: "v4.6.0", yes: true },
    );

    expect(fetch).toHaveBeenCalledWith(
      assetUrl(TARGET_VERSION, "install.sh"),
      expect.anything(),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      assetUrl("4.6.0", "install.sh"),
      expect.anything(),
    );
    expect(installedEnvironment().AGEMON_VERSION).toBe("4.6.0");
  });

  it("refuses a downgrade when the newest installer cannot be confirmed", async () => {
    const installDir = await defaultInstallDirectory();
    setLatestRelease(null);

    await expect(
      upgrade(
        { kind: "install-script", installDir },
        { version: "4.6.0", yes: true },
      ),
    ).rejects.toThrow(/newest installer/);
  });

  it("uses the requested release's own installer when the latest lookup fails", async () => {
    const installDir = await defaultInstallDirectory();
    setLatestRelease(null);

    await upgrade(
      { kind: "install-script", installDir },
      { version: TARGET_VERSION },
    );

    expect(installedEnvironment().AGEMON_VERSION).toBe(TARGET_VERSION);
  });

  it("refuses to pick a target for a running copy whose own version is not a release version", async () => {
    const installDir = await defaultInstallDirectory();

    await expect(
      runUpgrade({
        method: { kind: "install-script", installDir },
        runningVersion: "0.0.0-local",
        print: false,
        yes: true,
      }),
    ).rejects.toThrow(/not a release version; name the version/);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("rejects a requested version that is not a release version", async () => {
    const installDir = await defaultInstallDirectory();

    await expect(
      upgrade(
        { kind: "install-script", installDir },
        { version: "4.8;rm -rf ~" },
      ),
    ).rejects.toThrow(/not a release version/);
  });
});

describe("runUpgrade for other install methods", () => {
  async function npmGlobalMethod(): Promise<InstallMethod> {
    const prefix = await createTempDirectory();
    const packageRoot = join(prefix, "lib", "node_modules", "agemon");
    await mkdir(packageRoot, { recursive: true });
    return { kind: "npm-global", packageRoot, prefix };
  }

  it("installs the verified release tarball into the running copy's prefix", async () => {
    const method = await npmGlobalMethod();

    await expect(upgrade(method)).resolves.toBe(0);

    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(subprocess.npmCalls).toHaveLength(1);
    const [args] = subprocess.npmCalls;
    expect(args.slice(0, 7)).toEqual([
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      (method as { prefix: string }).prefix,
    ]);
    expect(args.at(-1)).toMatch(/agemon\.tgz$/);
  });

  it("installs nothing when the tarball does not match SHA256SUMS", async () => {
    const method = await npmGlobalMethod();
    publishRelease(TARGET_VERSION, { tarball: "tampered" });

    await expect(upgrade(method)).rejects.toThrow(/does not match/);
    expect(subprocess.npmCalls).toEqual([]);
  });

  it("only prints the verified steps with --print, with the prefix shell-quoted", async () => {
    const prefix = join(await createTempDirectory(), "Jane Doe's prefix");
    const packageRoot = join(prefix, "lib", "node_modules", "agemon");
    await mkdir(packageRoot, { recursive: true });

    await expect(
      upgrade({ kind: "npm-global", packageRoot, prefix }, { print: true }),
    ).resolves.toBe(0);

    expect(subprocess.npmCalls).toEqual([]);
    const printedSteps = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printedSteps).toContain("sha256sum -c -");
    expect(printedSteps).toContain(
      `--prefix '${prefix.replace("'", "'\\''")}' ./agemon.tgz`,
    );
  });

  it("refuses --print for an install-script copy", async () => {
    const installDir = await defaultInstallDirectory();

    await expect(
      upgrade({ kind: "install-script", installDir }, { print: true }),
    ).rejects.toThrow(/--print applies only to npm installs/);
  });

  it("explains npx instead of installing anything", async () => {
    await expect(upgrade({ kind: "npx" })).resolves.toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("npx agemon@latest"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "dev" } as InstallMethod, /source checkout/],
    [
      {
        kind: "unknown",
        packageRoot: "/x/node_modules/agemon",
      } as InstallMethod,
      /cannot tell how/,
    ],
  ])("refuses a %o copy", async (method, message) => {
    await expect(upgrade(method)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("runRollback", () => {
  async function installWithPrevious(): Promise<string> {
    const installDir = join(await createTempDirectory(), "agemon");
    await createInstallTree(installDir, TARGET_VERSION);
    await createInstallTree(`${installDir}.prev`, RUNNING_VERSION);
    return installDir;
  }

  async function markerVersion(directory: string): Promise<string> {
    return (await readFile(join(directory, ".agemon-install"), "utf8")).trim();
  }

  it("swaps with the previous install, and a second rollback swaps back", async () => {
    const installDir = await installWithPrevious();
    const method: InstallMethod = { kind: "install-script", installDir };

    await expect(runRollback({ method, yes: true })).resolves.toBe(0);
    expect(await markerVersion(installDir)).toBe(RUNNING_VERSION);
    expect(await markerVersion(`${installDir}.prev`)).toBe(TARGET_VERSION);

    await runRollback({ method, yes: true });
    expect(await markerVersion(installDir)).toBe(TARGET_VERSION);
  });

  it("refuses when no previous install was kept", async () => {
    const installDir = join(await createTempDirectory(), "agemon");
    await createInstallTree(installDir, TARGET_VERSION);

    await expect(
      runRollback({
        method: { kind: "install-script", installDir },
        yes: true,
      }),
    ).rejects.toThrow(/No previous install was kept/);
  });

  it("refuses a previous install without the installer's marker", async () => {
    const installDir = await installWithPrevious();
    await rm(join(`${installDir}.prev`, ".agemon-install"));

    await expect(
      runRollback({
        method: { kind: "install-script", installDir },
        yes: true,
      }),
    ).rejects.toThrow(/No previous install was kept/);
  });

  it("refuses a previous install that does not run as the version its marker names", async () => {
    const installDir = await installWithPrevious();
    await writeFile(join(`${installDir}.prev`, ".agemon-install"), "4.0.0\n");

    await expect(
      runRollback({
        method: { kind: "install-script", installDir },
        yes: true,
      }),
    ).rejects.toThrow(/cannot be rolled back to/);
    expect(await markerVersion(installDir)).toBe(TARGET_VERSION);
  });

  it("puts the current install back when the second rename fails", async () => {
    const installDir = await installWithPrevious();
    const { resetRenameCalls } = (await import(
      "node:fs/promises"
    )) as unknown as {
      resetRenameCalls: () => void;
    };
    resetRenameCalls();
    fsPromises.failRenameCall = 2;

    await expect(
      runRollback({
        method: { kind: "install-script", installDir },
        yes: true,
      }),
    ).rejects.toThrow(/EXDEV/);
    expect(await markerVersion(installDir)).toBe(TARGET_VERSION);
    expect(await markerVersion(`${installDir}.prev`)).toBe(RUNNING_VERSION);
  });

  it("only previews without a terminal or --yes", async () => {
    const installDir = await installWithPrevious();
    prompt.isInteractiveTerminal.mockReturnValue(false);

    await expect(
      runRollback({
        method: { kind: "install-script", installDir },
        yes: false,
      }),
    ).resolves.toBe(0);
    expect(await markerVersion(installDir)).toBe(TARGET_VERSION);
  });

  it("refuses npm installs and points at upgrading to a named version", async () => {
    await expect(
      runRollback({
        method: {
          kind: "npm-global",
          packageRoot: "/p/lib/node_modules/agemon",
          prefix: "/p",
        },
        yes: true,
      }),
    ).rejects.toThrow(/agemon upgrade <previous version>/);
  });
});
