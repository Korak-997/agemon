import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { writeJournal } from "../../src/core/apply-journal.js";

const createdTempDirectories: string[] = [];
const fixturesRoot = join(process.cwd(), "test/fixtures");
const DRIFT_EXIT_CODE = 2;

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

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FixtureRepo {
  repoDirectory: string;
  runFrom: (directory: string, argv: string[]) => Promise<CliRun>;
}

async function withCleanRepo(
  body: (repo: FixtureRepo) => Promise<void>,
): Promise<void> {
  const sandboxDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-exit-codes-test-")),
  );
  createdTempDirectories.push(sandboxDirectory);
  const repoDirectory = join(sandboxDirectory, "repo");
  await cp(join(fixturesRoot, "clean-repo"), repoDirectory, {
    recursive: true,
  });
  const osReleasePath = join(sandboxDirectory, "os-release");
  await writeFile(osReleasePath, "ID=ubuntu\n", "utf8");

  const originalCwd = process.cwd();
  const originalEnv = {
    HOME: process.env.HOME,
    AGEMON_DEV: process.env.AGEMON_DEV,
    AGEMON_FAKE_SUBPROCESS: process.env.AGEMON_FAKE_SUBPROCESS,
    AGEMON_FAKE_SERVICES: process.env.AGEMON_FAKE_SERVICES,
    AGEMON_OS_RELEASE_PATH: process.env.AGEMON_OS_RELEASE_PATH,
  };
  process.env.HOME = join(sandboxDirectory, "home");
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  process.env.AGEMON_FAKE_SERVICES = "1";
  process.env.AGEMON_OS_RELEASE_PATH = osReleasePath;

  const originalLog = console.log;
  const originalError = console.error;
  const runFrom = async (
    directory: string,
    argv: string[],
  ): Promise<CliRun> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    process.chdir(directory);
    console.log = (...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    };
    try {
      return {
        exitCode: await runCli(argv),
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      };
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.chdir(originalCwd);
    }
  };

  try {
    await body({ repoDirectory, runFrom });
  } finally {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
      setOrDeleteEnv(name, value);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("CLI exit codes", () => {
  it("status exits 0 when healthy and 2 once a managed file drifted", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      expect((await runFrom(repoDirectory, ["status"])).exitCode).toBe(0);

      const agentsPath = join(repoDirectory, "AGENTS.md");
      await writeFile(
        agentsPath,
        `${await readFile(agentsPath, "utf8")}hand edit\n`,
      );

      expect((await runFrom(repoDirectory, ["status"])).exitCode).toBe(
        DRIFT_EXIT_CODE,
      );
    });
  });
});

describe("status exit codes", () => {
  it("exits 0 in a repository agemon never touched, even with duplicated guidance", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const rules =
        "## Rules\n\n- Always write tests before code.\n- Never commit secrets.\n";
      await writeFile(join(repoDirectory, "AGENTS.md"), rules);
      await writeFile(join(repoDirectory, "CLAUDE.md"), rules);

      expect((await runFrom(repoDirectory, ["status"])).exitCode).toBe(0);
    });
  });

  it("exits 2 while an interrupted apply is waiting for 'agemon recover'", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeJournal(repoDirectory, {
        planId: "0123456789abcdef",
        startedAt: "2026-10-24T00:00:00.000Z",
        capabilityOrder: ["master-prompt"],
        ledgerBefore: [],
        snapshots: [],
      });

      expect((await runFrom(repoDirectory, ["status"])).exitCode).toBe(
        DRIFT_EXIT_CODE,
      );
    });
  });
});

describe("agemon.toml capability validation", () => {
  it("fails on an unknown capability id before any plugin runs", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(
        join(repoDirectory, "agemon.toml"),
        'capabilities = ["skils"]\n',
      );

      const run = await runFrom(repoDirectory, ["--yes"]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr.replace(/[\s│]+/g, " ")).toContain(
        "agemon.toml lists unknown capabilities: skils. Known: crg, daemon, skills, cli-tool, master-prompt",
      );
      expect(await exists(join(repoDirectory, ".agemon"))).toBe(false);
      expect(await exists(join(repoDirectory, "AGENTS.md"))).toBe(false);
    });
  });

  it("does nothing when --skip-daemon removes the only configured capability", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(
        join(repoDirectory, "agemon.toml"),
        'capabilities = ["daemon"]\n',
      );

      const run = await runFrom(repoDirectory, ["--yes", "--skip-daemon"]);

      expect(run.exitCode).toBe(0);
      expect(await exists(join(repoDirectory, ".agemon/state.json"))).toBe(
        false,
      );
      expect(await exists(join(repoDirectory, "AGENTS.md"))).toBe(false);
    });
  });
});

describe("--only validation", () => {
  it.each([
    [["--yes", "--only", ","], "--only needs at least one plugin id"],
    [
      ["--yes", "--skip-daemon", "--only", "daemon"],
      "--only daemon conflicts with --skip-daemon",
    ],
  ])("rejects %j", async (argv, message) => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const run = await runFrom(repoDirectory, argv);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(message);
    });
  });
});

describe("repository root resolution", () => {
  it("writes into the git top-level when run from a subdirectory, and says so", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      execFileSync("git", ["init", "-q"], { cwd: repoDirectory });
      const nested = join(repoDirectory, "sub", "dir");
      await mkdir(nested, { recursive: true });

      const run = await runFrom(nested, ["--yes", "--skip-daemon"]);

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toContain(
        `Using repository root ${repoDirectory} (not the current directory).`,
      );
      expect(await exists(join(repoDirectory, "AGENTS.md"))).toBe(true);
      expect(await exists(join(repoDirectory, ".agemon/state.json"))).toBe(
        true,
      );
      expect(await exists(join(nested, "AGENTS.md"))).toBe(false);
      expect(await exists(join(nested, ".agemon"))).toBe(false);
    });
  });
});

describe("nuke", () => {
  it("--skip-daemon keeps code-review-graph while the daemon is installed", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      const ledgerPath = join(repoDirectory, ".agemon/state.json");
      const entriesOf = async (plugin: string): Promise<unknown[]> =>
        (
          JSON.parse(await readFile(ledgerPath, "utf8")) as {
            actions: { plugin: string }[];
          }
        ).actions.filter((entry) => entry.plugin === plugin);
      const crgBefore = await entriesOf("crg");
      const daemonBefore = await entriesOf("daemon");
      expect(daemonBefore.length).toBeGreaterThan(0);

      const run = await runFrom(repoDirectory, [
        "nuke",
        "--yes",
        "--skip-daemon",
      ]);

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("kept: crg (daemon is still installed)");
      await expect(entriesOf("crg")).resolves.toEqual(crgBefore);
      await expect(entriesOf("daemon")).resolves.toEqual(daemonBefore);
      expect(await exists(join(repoDirectory, "AGENTS.md"))).toBe(false);
    });
  });

  it("--dry-run leaves the ledger and agemon.toml byte-identical", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      const statePath = join(repoDirectory, ".agemon/state.json");
      const configPath = join(repoDirectory, "agemon.toml");
      const stateBefore = await readFile(statePath, "utf8");
      const configBefore = await readFile(configPath, "utf8");

      expect(
        (await runFrom(repoDirectory, ["nuke", "--dry-run"])).exitCode,
      ).toBe(0);

      await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
      await expect(readFile(configPath, "utf8")).resolves.toBe(configBefore);
    });
  });

  it("only previews without --yes in a non-interactive session", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      const statePath = join(repoDirectory, ".agemon/state.json");
      const stateBefore = await readFile(statePath, "utf8");

      expect((await runFrom(repoDirectory, ["nuke"])).exitCode).toBe(0);

      await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
      expect(await exists(join(repoDirectory, "AGENTS.md"))).toBe(true);
    });
  });

  it("exits 1 when a plugin cannot be reversed, after reversing the rest", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      await rm(join(repoDirectory, "CLAUDE.md"));
      await mkdir(join(repoDirectory, "CLAUDE.md"));

      const run = await runFrom(repoDirectory, ["nuke", "--yes"]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr.replace(/[\s│]+/g, " ")).toContain(
        "nuke could not reverse master-prompt",
      );
      expect(await exists(join(repoDirectory, "agemon.toml"))).toBe(true);
      const ledger = JSON.parse(
        await readFile(join(repoDirectory, ".agemon/state.json"), "utf8"),
      ) as { actions: { plugin: string }[] };
      expect(new Set(ledger.actions.map((entry) => entry.plugin))).toEqual(
        new Set(["master-prompt"]),
      );
    });
  });
});

describe("--verbose", () => {
  it("prints each subprocess's command line beneath its step", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const run = await runFrom(repoDirectory, [
        "--yes",
        "--skip-daemon",
        "--verbose",
      ]);

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toMatch(/^\s*\$ npx skills list --json \(exit 0\)$/m);
      expect(run.stdout).toMatch(/^\s*│ /m);
    });
  });
});
