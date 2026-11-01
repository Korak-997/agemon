import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffSnapshots, snapshotTree } from "../../scripts/sandbox/snapshot.js";
import { runCli } from "../../src/cli/index.js";

const { mockDetectOnLinuxHost, mockInstallLocationOnLinuxHost } =
  await vi.hoisted(() => import("./linux-host.js"));
vi.mock("../../src/platform/detect.js", mockDetectOnLinuxHost);
vi.mock("../../src/core/install-location.js", mockInstallLocationOnLinuxHost);

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

const UNRESOLVED_CONFLICT_EXIT_CODE = 2;

async function runRoundtripFixture(
  fixtureName: string,
  nukeArgs = ["nuke", "--yes"],
  installExitCode = 0,
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
    expect(await runCli(["--yes"])).toBe(installExitCode);

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
    const { beforeSnapshot, afterSnapshot } = await runRoundtripFixture(
      "existing-claude-md",
      ["nuke", "--yes"],
      UNRESOLVED_CONFLICT_EXIT_CODE,
    );
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("restores messy agent rules fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } = await runRoundtripFixture(
      "messy-agent-rules",
      ["nuke", "--yes"],
      UNRESOLVED_CONFLICT_EXIT_CODE,
    );
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("restores preexisting CRG fixture byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("preexisting-crg");
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("no-gitignore fixture: nuke deletes the .gitignore agemon created and restores the repo byte-identically", async () => {
    const { beforeSnapshot, afterSnapshot } =
      await runRoundtripFixture("no-gitignore");

    expect(beforeSnapshot.has("repo/.gitignore")).toBe(false);
    expect(diffSnapshots(beforeSnapshot, afterSnapshot)).toEqual([]);
  });

  it("clean-repo with skills: nuke leaves no .agents, .claude or skills-lock.json", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      expect(await runCli(["--yes"])).toBe(0);
      expect(existsSync(join(repoDirectory, ".claude/skills"))).toBe(true);
      expect(existsSync(join(repoDirectory, "skills-lock.json"))).toBe(true);
      expect(await readFile(join(repoDirectory, ".gitignore"), "utf8")).toBe(
        "/.agemon/\n/skills-lock.json\n",
      );

      expect(await runCli(["nuke", "--yes"])).toBe(0);

      for (const leftover of [
        ".claude/skills",
        ".claude",
        ".agents",
        "skills-lock.json",
        ".agemon",
      ]) {
        expect(existsSync(join(repoDirectory, leftover))).toBe(false);
      }
      expect(await readFile(join(repoDirectory, ".gitignore"), "utf8")).toBe(
        "/.agemon/\n",
      );
    });
  });

  it("nuke --only agents removes the empty .claude/agents agemon created and keeps .claude while skills remain", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      expect(
        await runCli(["--yes", "--skill-groups", "essentials,geo-seo"]),
      ).toBe(0);
      expect(existsSync(join(repoDirectory, ".claude/agents"))).toBe(true);

      expect(await runCli(["nuke", "--yes", "--only", "agents"])).toBe(0);

      expect(existsSync(join(repoDirectory, ".claude/agents"))).toBe(false);
      expect(existsSync(join(repoDirectory, ".claude/skills"))).toBe(true);

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(existsSync(join(repoDirectory, ".claude"))).toBe(false);
    });
  });

  it("nuke --dry-run prints the footprint decisions and changes nothing", async () => {
    await withFixtureRepo("no-gitignore", async (repoDirectory) => {
      expect(await runCli(["--yes"])).toBe(0);
      const before = await snapshotTree(repoDirectory);

      const printed: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      };
      try {
        expect(await runCli(["nuke", "--dry-run"])).toBe(0);
      } finally {
        console.log = originalLog;
      }

      expect(diffSnapshots(before, await snapshotTree(repoDirectory))).toEqual(
        [],
      );
      const output = printed.join("\n");
      expect(output).toContain(
        "Would remove empty directories agemon created: .claude/skills, .claude",
      );
      expect(output).toContain(
        "Would remove from .gitignore: /skills-lock.json, /.agemon/ (added by agemon)",
      );

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(existsSync(join(repoDirectory, ".gitignore"))).toBe(false);
    });
  });

  it("removes the graph and the pipx install that agemon created", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      const graphPath = join(repoDirectory, ".code-review-graph");
      const pipxMetadataPath = join(
        process.env.HOME ?? "",
        ".agemon/fake-pipx/venvs/code-review-graph/pipx_metadata.json",
      );

      expect(await runCli(["--yes"])).toBe(0);
      expect(existsSync(join(graphPath, "graph.db"))).toBe(true);
      expect(existsSync(pipxMetadataPath)).toBe(true);

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(existsSync(graphPath)).toBe(false);
      expect(existsSync(pipxMetadataPath)).toBe(false);
    });
  });

  it("fails install on unsupported non-Ubuntu platform", async () => {
    const { installExitCode, beforeSnapshot, afterSnapshot } =
      await runInstallFixture("non-ubuntu", "fedora");
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

      expect(await runCli(["--yes"])).toBe(UNRESOLVED_CONFLICT_EXIT_CODE);

      const merged = await readFile(agentsPath, "utf8");
      expect(merged.startsWith(originalAgents)).toBe(true);
      expect(merged).toContain("<!-- agemon:start:agent-rules -->");
      expect(merged).toContain("<!-- agemon:end:agent-rules -->");

      // pointer files here carry independent rules => conflict => never touched
      expect(await readFile(join(repoDirectory, "CLAUDE.md"), "utf8")).toBe(
        originalClaude,
      );

      expect(await runCli(["--yes"])).toBe(UNRESOLVED_CONFLICT_EXIT_CODE);
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

describe("phase 5 — block-level revert without a backup dependency", () => {
  it("restores hand-written AGENTS.md prose by excising the block when backups are gone", async () => {
    await withFixtureRepo("messy-agent-rules", async (repoDirectory) => {
      const agentsPath = join(repoDirectory, "AGENTS.md");
      const originalAgents = await readFile(agentsPath, "utf8");

      expect(await runCli(["--yes"])).toBe(UNRESOLVED_CONFLICT_EXIT_CODE);
      expect(await readFile(agentsPath, "utf8")).not.toBe(originalAgents);

      await rm(join(repoDirectory, ".agemon", "backups"), {
        recursive: true,
        force: true,
      });

      expect(await runCli(["nuke", "--yes"])).toBe(0);
      expect(await readFile(agentsPath, "utf8")).toBe(originalAgents);
    });
  });

  it("keeps an AGENTS.md with unbalanced markers and saves the original beside it", async () => {
    await withFixtureRepo("messy-agent-rules", async (repoDirectory) => {
      const agentsPath = join(repoDirectory, "AGENTS.md");
      const originalAgents = await readFile(agentsPath, "utf8");

      expect(await runCli(["--yes"])).toBe(UNRESOLVED_CONFLICT_EXIT_CODE);

      const merged = await readFile(agentsPath, "utf8");
      const brokenMarkers = merged.replace(
        "<!-- agemon:end:agent-rules -->",
        "",
      );
      await writeFile(agentsPath, brokenMarkers, "utf8");

      const printed: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      };
      try {
        expect(await runCli(["nuke", "--yes"])).toBe(0);
      } finally {
        console.log = originalLog;
      }

      expect(await readFile(agentsPath, "utf8")).toBe(brokenMarkers);
      expect(await readFile(`${agentsPath}.agemon-original`, "utf8")).toBe(
        originalAgents,
      );
      expect(printed.join("\n")).toContain(
        "manual cleanup needed: AGENTS.md changed since agemon wrote it",
      );
    });
  });
});

describe("phase 6 — re-check, status, and persisted intent", () => {
  it("writes a committed agemon.toml and a second run changes nothing on disk", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      expect(await runCli(["--yes"])).toBe(0);

      const config = await readFile(join(repoDirectory, "agemon.toml"), "utf8");
      expect(config).toContain("master-prompt");
      expect(config).toContain("conflict_decisions");

      const afterFirstRun = await snapshotTree(repoDirectory);
      expect(await runCli(["--yes"])).toBe(0);
      const afterSecondRun = await snapshotTree(repoDirectory);

      expect(diffSnapshots(afterFirstRun, afterSecondRun)).toEqual([]);
    });
  });

  it("agemon status reports a healthy environment after a successful run", async () => {
    await withFixtureRepo("clean-repo", async () => {
      expect(await runCli(["--yes"])).toBe(0);

      const printed: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      };
      try {
        expect(await runCli(["status"])).toBe(0);
      } finally {
        console.log = originalLog;
      }

      expect(printed.join("\n")).toContain("Environment healthy");
    });
  });

  it("a non-interactive re-run without --yes reports the pending operations it cannot consent to", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      expect(await runCli(["--yes"])).toBe(0);
      await rm(join(repoDirectory, ".agemon"), {
        recursive: true,
        force: true,
      });

      expect(await runCli([])).toBe(2);
    });
  });
});

describe("non-interactive & --dry-run parity", () => {
  it("a first non-interactive run previews an applyable plan and writes nothing else", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      const before = await snapshotTree(repoDirectory);

      expect(await runCli([])).toBe(0);

      const changes = diffSnapshots(before, await snapshotTree(repoDirectory));
      expect(changes.every((line) => line.path.startsWith(".agemon/"))).toBe(
        true,
      );
      expect(
        changes.some(
          (line) =>
            line.kind === "added" &&
            /^\.agemon\/plans\/.+\.json$/.test(line.path),
        ),
      ).toBe(true);
      expect(changes.some((line) => line.path === "agemon.toml")).toBe(false);
    });
  });

  it("--dry-run stops after the preview and leaves the repo untouched", async () => {
    await withFixtureRepo("clean-repo", async (repoDirectory) => {
      const before = await snapshotTree(repoDirectory);

      expect(await runCli(["--dry-run"])).toBe(0);

      const changes = diffSnapshots(before, await snapshotTree(repoDirectory));
      expect(changes.every((line) => line.path.startsWith(".agemon/"))).toBe(
        true,
      );
      expect(changes.some((line) => line.path === "agemon.toml")).toBe(false);
    });
  });
});
