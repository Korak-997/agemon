import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffSnapshots, snapshotTree } from "../../scripts/sandbox/snapshot.js";
import { runCli } from "../../src/cli/index.js";

const createdTempDirectories: string[] = [];
const fixturesRoot = join(process.cwd(), "test/fixtures");

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function setOrDeleteEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function runRoundtripFixture(fixtureName: string): Promise<void> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-roundtrip-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  const repoDirectory = join(sandboxDirectory, "repo");
  const homeDirectory = join(sandboxDirectory, "home");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, { recursive: true });

  const fixtureOsReleaseDirectory = join(repoDirectory, ".sandbox");
  const fixtureOsReleasePath = join(fixtureOsReleaseDirectory, "os-release");
  await mkdir(fixtureOsReleaseDirectory, { recursive: true });
  await writeFile(fixtureOsReleasePath, "ID=ubuntu\n", "utf8");

  const beforeSnapshot = await snapshotTree(sandboxDirectory);

  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalDev = process.env.AGEMON_DEV;
  const originalFakeSubprocess = process.env.AGEMON_FAKE_SUBPROCESS;
  const originalFakeServices = process.env.AGEMON_FAKE_SERVICES;
  const originalFakePreinstalledCrg = process.env.AGEMON_FAKE_PREINSTALLED_CRG;
  const originalOsReleasePath = process.env.AGEMON_OS_RELEASE_PATH;

  process.chdir(repoDirectory);
  process.env.HOME = homeDirectory;
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  process.env.AGEMON_FAKE_SERVICES = "1";
  process.env.AGEMON_OS_RELEASE_PATH = fixtureOsReleasePath;
  setOrDeleteEnv(
    "AGEMON_FAKE_PREINSTALLED_CRG",
    fixtureName === "preexisting-crg" ? "1" : undefined,
  );

  try {
    const installExitCode = await runCli(["--yes"]);
    expect(installExitCode).toBe(0);

    const nukeExitCode = await runCli(["nuke", "--yes"]);
    expect(nukeExitCode).toBe(0);
  } finally {
    process.chdir(originalCwd);
    setOrDeleteEnv("HOME", originalHome);
    setOrDeleteEnv("AGEMON_DEV", originalDev);
    setOrDeleteEnv("AGEMON_FAKE_SUBPROCESS", originalFakeSubprocess);
    setOrDeleteEnv("AGEMON_FAKE_SERVICES", originalFakeServices);
    setOrDeleteEnv("AGEMON_FAKE_PREINSTALLED_CRG", originalFakePreinstalledCrg);
    setOrDeleteEnv("AGEMON_OS_RELEASE_PATH", originalOsReleasePath);
  }

  const afterSnapshot = await snapshotTree(sandboxDirectory);
  expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
}

async function runInstallFixture(
  fixtureName: string,
  osId: string,
): Promise<{
  installExitCode: number;
  beforeSnapshot: Awaited<ReturnType<typeof snapshotTree>>;
  afterSnapshot: Awaited<ReturnType<typeof snapshotTree>>;
}> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-install-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  const repoDirectory = join(sandboxDirectory, "repo");
  const homeDirectory = join(sandboxDirectory, "home");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, { recursive: true });

  const fixtureOsReleaseDirectory = join(repoDirectory, ".sandbox");
  const fixtureOsReleasePath = join(fixtureOsReleaseDirectory, "os-release");
  await mkdir(fixtureOsReleaseDirectory, { recursive: true });
  await writeFile(fixtureOsReleasePath, `ID=${osId}\n`, "utf8");

  const beforeSnapshot = await snapshotTree(sandboxDirectory);

  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalDev = process.env.AGEMON_DEV;
  const originalFakeSubprocess = process.env.AGEMON_FAKE_SUBPROCESS;
  const originalFakeServices = process.env.AGEMON_FAKE_SERVICES;
  const originalFakePreinstalledCrg = process.env.AGEMON_FAKE_PREINSTALLED_CRG;
  const originalOsReleasePath = process.env.AGEMON_OS_RELEASE_PATH;

  process.chdir(repoDirectory);
  process.env.HOME = homeDirectory;
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  process.env.AGEMON_FAKE_SERVICES = "1";
  setOrDeleteEnv(
    "AGEMON_FAKE_PREINSTALLED_CRG",
    fixtureName === "preexisting-crg" ? "1" : undefined,
  );
  process.env.AGEMON_OS_RELEASE_PATH = fixtureOsReleasePath;

  try {
    const installExitCode = await runCli(["--yes"]);
    const afterSnapshot = await snapshotTree(sandboxDirectory);
    return { installExitCode, beforeSnapshot, afterSnapshot };
  } finally {
    process.chdir(originalCwd);
    setOrDeleteEnv("HOME", originalHome);
    setOrDeleteEnv("AGEMON_DEV", originalDev);
    setOrDeleteEnv("AGEMON_FAKE_SUBPROCESS", originalFakeSubprocess);
    setOrDeleteEnv("AGEMON_FAKE_SERVICES", originalFakeServices);
    setOrDeleteEnv("AGEMON_FAKE_PREINSTALLED_CRG", originalFakePreinstalledCrg);
    setOrDeleteEnv("AGEMON_OS_RELEASE_PATH", originalOsReleasePath);
  }
}

describe("nuke roundtrip", () => {
  it("restores clean fixture byte-identically", async () => {
    await runRoundtripFixture("clean-repo");
  });

  it("restores existing CLAUDE fixture byte-identically", async () => {
    await runRoundtripFixture("existing-claude-md");
  });

  it("restores messy agent rules fixture byte-identically", async () => {
    await runRoundtripFixture("messy-agent-rules");
  });

  it("restores preexisting CRG fixture byte-identically", async () => {
    await runRoundtripFixture("preexisting-crg");
  });

  it("fails install on unsupported non-Ubuntu platform", async () => {
    const { installExitCode, beforeSnapshot, afterSnapshot } =
      await runInstallFixture("non-ubuntu", "debian");
    expect(installExitCode).toBe(1);
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });
});
