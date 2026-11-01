import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffSnapshots, snapshotTree } from "../../scripts/sandbox/snapshot.js";
import type { PlatformCapabilities } from "../../src/platform/detect.js";

const platformOverride = vi.hoisted(() => ({
  value: undefined as Partial<PlatformCapabilities> | undefined,
}));
vi.mock("../../src/platform/detect.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/platform/detect.js")>();
  return {
    ...actual,
    detectPlatformCapabilities: async (
      input?: Parameters<typeof actual.detectPlatformCapabilities>[0],
    ) => ({
      ...(await actual.detectPlatformCapabilities(input)),
      ...platformOverride.value,
    }),
  };
});
const rootOnMacOS = vi.hoisted(() => ({ simulate: false }));
vi.mock("../../src/core/install-location.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/install-location.js")>();
  return {
    ...actual,
    assertNotRootOnMacOS: () =>
      rootOnMacOS.simulate
        ? actual.assertNotRootOnMacOS("darwin", 0)
        : actual.assertNotRootOnMacOS(),
  };
});
const updateCheck = vi.hoisted(() => ({ startUpdateCheck: vi.fn() }));
vi.mock("../../src/core/update-check.js", () => updateCheck);

const { runCli } = await import("../../src/cli/index.js");
const { loadConfig } = await import("../../src/core/config.js");
const { StateManifest } = await import("../../src/core/state-manifest.js");

const fixturesRoot = join(process.cwd(), "test/fixtures");
const NO_SERVICE_MANAGER: Partial<PlatformCapabilities> = {
  serviceManager: "none",
};
const MACOS: PlatformCapabilities = {
  family: "darwin",
  arch: "arm64",
  serviceManager: "launchd",
  unsupportedReason: null,
};
const INTEL_MAC: Partial<PlatformCapabilities> = {
  family: "darwin",
  arch: "x64",
};

let sandboxDirectory: string;
let repoDirectory: string;
let osReleasePath: string;
let originalCwd: string;
let stderrLines: string[];
let stdoutLines: string[];

function stderrText(): string {
  return stderrLines
    .join("\n")
    .replace(/[│╭╮╰╯─]/g, "")
    .replace(/\s+/g, " ");
}

beforeEach(async () => {
  platformOverride.value = undefined;
  rootOnMacOS.simulate = false;
  updateCheck.startUpdateCheck.mockReturnValue(null);
  sandboxDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-platform-gating-test-")),
  );
  repoDirectory = join(sandboxDirectory, "repo");
  await cp(join(fixturesRoot, "clean-repo"), repoDirectory, {
    recursive: true,
  });
  osReleasePath = join(sandboxDirectory, "os-release");
  await writeFile(osReleasePath, "ID=ubuntu\n", "utf8");
  vi.stubEnv("HOME", join(sandboxDirectory, "home"));
  vi.stubEnv("XDG_STATE_HOME", join(sandboxDirectory, "state"));
  vi.stubEnv("AGEMON_DEV", "1");
  vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");
  vi.stubEnv("AGEMON_FAKE_SERVICES", "1");
  vi.stubEnv("AGEMON_OS_RELEASE_PATH", osReleasePath);
  stderrLines = [];
  stdoutLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    stdoutLines.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    stderrLines.push(String(line));
  });
  originalCwd = process.cwd();
  process.chdir(repoDirectory);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  updateCheck.startUpdateCheck.mockReset();
  await rm(sandboxDirectory, { recursive: true, force: true });
});

describe("read-only commands on an unsupported platform", () => {
  it.each([
    ["Fedora", "ID=fedora\n"],
    ["a missing os-release", null],
  ])("inspect, status and plan exit 0 on %s", async (_name, contents) => {
    if (contents === null) {
      await rm(osReleasePath);
    } else {
      await writeFile(osReleasePath, contents, "utf8");
    }

    expect(await runCli(["inspect"])).toBe(0);
    expect(await runCli(["status"])).toBe(0);
    expect(await runCli(["plan"])).toBe(0);
  });

  it("inspect, status and plan exit 0 on macOS", async () => {
    platformOverride.value = MACOS;
    vi.stubEnv("AGEMON_FAKE_SERVICES", "");

    expect(await runCli(["inspect"])).toBe(0);
    expect(await runCli(["status"])).toBe(0);
    expect(await runCli(["plan"])).toBe(0);
  });
});

describe("changing commands on an unsupported platform", () => {
  it.each([[["--yes"]], [["apply", "--yes"]], [["nuke", "--yes"]]])(
    "%j refuses on Fedora before any write or update check",
    async (argv) => {
      await writeFile(osReleasePath, "ID=fedora\n", "utf8");
      const before = await snapshotTree(sandboxDirectory);

      expect(await runCli(argv)).toBe(1);

      expect(stderrText()).toContain(
        "agemon can only change Ubuntu, Debian, their derivatives and macOS.",
      );
      expect(
        diffSnapshots(before, await snapshotTree(sandboxDirectory)),
      ).toEqual([]);
      expect(updateCheck.startUpdateCheck).not.toHaveBeenCalled();
    },
  );

  it.each([
    [["--yes"]],
    [["apply", "--yes"]],
    [["nuke", "--yes"]],
    [["upgrade", "--yes"]],
    [["self-uninstall", "--yes"]],
  ])("%j refuses root on macOS before any write", async (argv) => {
    rootOnMacOS.simulate = true;
    const before = await snapshotTree(sandboxDirectory);

    expect(await runCli(argv)).toBe(1);

    expect(stderrText()).toContain(
      "On macOS agemon runs as your own user, never as root",
    );
    expect(diffSnapshots(before, await snapshotTree(sandboxDirectory))).toEqual(
      [],
    );
  });
});

describe("macOS", () => {
  it("install runs on macOS with the daemon and every capability", async () => {
    platformOverride.value = MACOS;

    expect(await runCli(["--yes"])).toBe(0);

    expect(stderrText()).not.toContain("skipped");
    expect(
      new Set(
        (await StateManifest.load(repoDirectory))
          .getActions()
          .map((entry) => entry.plugin),
      ),
    ).toEqual(
      new Set([
        "crg",
        "daemon",
        "skills",
        "agents",
        "cli-tool",
        "master-prompt",
        "workspace",
      ]),
    );
  });

  it("an Intel Mac skips cli-tool with a notice and keeps it in agemon.toml", async () => {
    platformOverride.value = INTEL_MAC;

    expect(await runCli(["--yes"])).toBe(0);

    expect(stderrLines).toContainEqual(
      expect.stringContaining(
        "cli-tool skipped: agnix has no pinned build for darwin-x64.",
      ),
    );
    const capabilities = (await loadConfig(repoDirectory))?.capabilities;
    expect(capabilities).toContain("cli-tool");
    expect(
      (await StateManifest.load(repoDirectory))
        .getActions()
        .some((entry) => entry.plugin === "cli-tool"),
    ).toBe(false);
  });

  it("refuses an explicit --only cli-tool on an Intel Mac", async () => {
    platformOverride.value = INTEL_MAC;

    expect(await runCli(["--yes", "--only", "cli-tool"])).toBe(1);

    expect(stderrText()).toContain(
      "--only cli-tool cannot run here: agnix has no pinned build for darwin-x64.",
    );
  });
});

describe("daemon without a service manager", () => {
  it("install skips the daemon with a notice and still persists it in agemon.toml", async () => {
    platformOverride.value = NO_SERVICE_MANAGER;

    expect(await runCli(["--yes"])).toBe(0);

    expect(stderrLines).toContainEqual(
      expect.stringContaining(
        "daemon skipped: systemd is not running on this machine.",
      ),
    );
    expect(
      existsSync(join(sandboxDirectory, "home", ".agemon", "fake-services")),
    ).toBe(false);
    expect((await loadConfig(repoDirectory))?.capabilities).toContain("daemon");
  });

  it("a first --only crg run persists only crg", async () => {
    platformOverride.value = NO_SERVICE_MANAGER;

    expect(await runCli(["--yes", "--only", "crg"])).toBe(0);

    expect((await loadConfig(repoDirectory))?.capabilities).toEqual(["crg"]);
    expect(stderrText()).not.toContain("daemon skipped");
  });

  it("refuses an explicit --only daemon with the reason", async () => {
    platformOverride.value = NO_SERVICE_MANAGER;

    expect(await runCli(["--yes", "--only", "daemon"])).toBe(1);

    expect(stderrText()).toContain(
      "--only daemon cannot run here: systemd is not running on this machine.",
    );
  });

  it("nuke with daemon entries names the unit, exits non-zero and keeps crg", async () => {
    expect(await runCli(["--yes"])).toBe(0);
    platformOverride.value = NO_SERVICE_MANAGER;
    vi.stubEnv("AGEMON_FAKE_SERVICES", "");

    const nukeExitCode = await runCli(["nuke", "--yes"]);

    expect(nukeExitCode).not.toBe(0);
    expect(stderrText().replaceAll(" ", "")).toContain(
      `systemdisnotrunningonthismachine;remove${join(sandboxDirectory, "home", ".config", "systemd", "user", "agemon-crg-")}`,
    );
    const remainingPlugins = (await StateManifest.load(repoDirectory))
      .getActions()
      .map((entry) => entry.plugin);
    expect(remainingPlugins).toContain("daemon");
    expect(remainingPlugins).toContain("crg");
  });

  it("nuke keeps a recorded unit that now runs for another repository", async () => {
    expect(await runCli(["--yes"])).toBe(0);
    const fakeServiceMarker = (await StateManifest.load(repoDirectory))
      .getActions()
      .find((entry) => entry.type === "registered-service")?.target;
    const unitName = basename(String(fakeServiceMarker), ".json");
    expect(unitName).toMatch(/^agemon-crg-daemon-repo-[0-9a-f]{8}\.service$/);
    const otherRepository = join(sandboxDirectory, "other-repo");
    await mkdir(otherRepository);
    const unitDirectory = join(
      sandboxDirectory,
      "home",
      ".config",
      "systemd",
      "user",
    );
    const unitPath = join(unitDirectory, unitName);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      unitPath,
      `[Service]\nWorkingDirectory=${otherRepository}\n`,
      "utf8",
    );
    platformOverride.value = NO_SERVICE_MANAGER;
    vi.stubEnv("AGEMON_FAKE_SERVICES", "");

    await runCli(["nuke", "--yes"]);

    expect(stdoutLines.join("\n")).toContain(
      `Keeping user service ${unitName}: it now runs for ${otherRepository}`,
    );
    expect(stderrText()).not.toContain("by hand");
    expect(existsSync(unitPath)).toBe(true);
  });
});
