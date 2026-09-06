import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function runRoundtripFixture(
  fixtureName: string,
  nukeArgs = ["nuke", "--yes"],
) {
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

    const nukeExitCode = await runCli(nukeArgs);
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
  return { beforeSnapshot, afterSnapshot };
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
  it("scopes nuke to the requested plugin", async () => {
    const { afterSnapshot } = await runRoundtripFixture("clean-repo", [
      "nuke",
      "--yes",
      "--only",
      "skills",
    ]);

    expect(afterSnapshot.has("repo/AGENTS.md")).toBe(true);
  });

  it("restores clean fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("clean-repo");
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("restores existing CLAUDE fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("existing-claude-md");
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("restores messy agent rules fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("messy-agent-rules");
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("restores preexisting CRG fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("preexisting-crg");
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("creates .gitignore with /.agemon/ when the repo has none and the user accepts", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("no-gitignore");

    expect(beforeSnapshot.has("repo/.gitignore")).toBe(false);
    expect(afterSnapshot.has("repo/.gitignore")).toBe(true);
    expect(afterSnapshot.get("repo/README.md")).toBe(
      beforeSnapshot.get("repo/README.md"),
    );
  });

  it("fails install on unsupported non-Ubuntu platform", async () => {
    const { installExitCode, beforeSnapshot, afterSnapshot } =
      await runInstallFixture("non-ubuntu", "debian");
    expect(installExitCode).toBe(1);
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });
});

async function withFixtureRepo(
  fixtureName: string,
  body: (repoDirectory: string) => Promise<void>,
): Promise<void> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-phase5-test-"));
  createdTempDirectories.push(sandboxDirectory);

  const repoDirectory = join(sandboxDirectory, "repo");
  const homeDirectory = join(sandboxDirectory, "home");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, { recursive: true });

  const fixtureOsReleaseDirectory = join(repoDirectory, ".sandbox");
  const fixtureOsReleasePath = join(fixtureOsReleaseDirectory, "os-release");
  await mkdir(fixtureOsReleaseDirectory, { recursive: true });
  await writeFile(fixtureOsReleasePath, "ID=ubuntu\n", "utf8");

  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalDev = process.env.AGEMON_DEV;
  const originalFakeSubprocess = process.env.AGEMON_FAKE_SUBPROCESS;
  const originalFakeServices = process.env.AGEMON_FAKE_SERVICES;
  const originalOsReleasePath = process.env.AGEMON_OS_RELEASE_PATH;

  process.chdir(repoDirectory);
  process.env.HOME = homeDirectory;
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  process.env.AGEMON_FAKE_SERVICES = "1";
  process.env.AGEMON_OS_RELEASE_PATH = fixtureOsReleasePath;

  try {
    await body(repoDirectory);
  } finally {
    process.chdir(originalCwd);
    setOrDeleteEnv("HOME", originalHome);
    setOrDeleteEnv("AGEMON_DEV", originalDev);
    setOrDeleteEnv("AGEMON_FAKE_SUBPROCESS", originalFakeSubprocess);
    setOrDeleteEnv("AGEMON_FAKE_SERVICES", originalFakeServices);
    setOrDeleteEnv("AGEMON_OS_RELEASE_PATH", originalOsReleasePath);
  }
}

describe("phase 5 — dedup-safe rule-file reconciliation", () => {
  it("appends agemon's block to hand-written AGENTS.md, stays idempotent, and reverses cleanly", async () => {
    await withFixtureRepo("messy-agent-rules", async (repoDirectory) => {
      const agentsPath = join(repoDirectory, "AGENTS.md");
      const originalAgents = await readFile(agentsPath, "utf8");
      const originalClaude = await readFile(
        join(repoDirectory, "CLAUDE.md"),
        "utf8",
      );

      expect(await runCli(["--yes"])).toBe(0);

      const merged = await readFile(agentsPath, "utf8");
      expect(merged.startsWith(originalAgents)).toBe(true);
      expect(merged).toContain("<!-- agemon:start:agent-rules -->");
      expect(merged).toContain("<!-- agemon:end:agent-rules -->");

      // pointer files here carry independent rules => conflict => never touched
      expect(await readFile(join(repoDirectory, "CLAUDE.md"), "utf8")).toBe(
        originalClaude,
      );

      expect(await runCli(["--yes"])).toBe(0);
      expect(await readFile(agentsPath, "utf8")).toBe(merged);

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(await readFile(agentsPath, "utf8")).toBe(originalAgents);
    });
  });

  it("adopts an existing AGENTS.md pointer instead of rewriting it", async () => {
    await withFixtureRepo("existing-claude-md", async (repoDirectory) => {
      const claudePath = join(repoDirectory, "CLAUDE.md");
      await writeFile(
        claudePath,
        "# Claude\n\nSee AGENTS.md — the single source of truth for this repo.\n",
        "utf8",
      );
      const pointerContents = await readFile(claudePath, "utf8");

      expect(await runCli(["--yes"])).toBe(0);

      expect(await readFile(claudePath, "utf8")).toBe(pointerContents);
      expect(
        await readFile(join(repoDirectory, "AGENTS.md"), "utf8"),
      ).toContain("<!-- agemon:start:agent-rules -->");

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(await readFile(claudePath, "utf8")).toBe(pointerContents);
    });
  });
});
