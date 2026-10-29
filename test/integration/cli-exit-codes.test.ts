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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/index.js";
import { writeJournal } from "../../src/core/apply-journal.js";
import { resetFakeSubprocessState } from "../../src/core/fake-subprocess.js";

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
        "agemon.toml lists unknown capabilities: skils. Known: crg, daemon, skills, agents, cli-tool, master-prompt",
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

describe("self-uninstall", () => {
  it("refuses to remove a source checkout", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const run = await runFrom(repoDirectory, ["self-uninstall", "--yes"]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("source checkout");
    });
  });

  it("refuses root with another user's HOME before finding out how agemon was installed", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const geteuid = vi.spyOn(process, "geteuid").mockReturnValue(0);
      try {
        const run = await runFrom(repoDirectory, [
          "self-uninstall",
          "--dry-run",
        ]);

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("another user's environment");
      } finally {
        geteuid.mockRestore();
      }
    });
  });
});

describe("upgrade", () => {
  it("refuses to upgrade a source checkout, naming git", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const run = await runFrom(repoDirectory, ["upgrade", "4.8.0"]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("update it with git");
    });
  });

  it("refuses root with another user's HOME before finding out how agemon was installed", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const geteuid = vi.spyOn(process, "geteuid").mockReturnValue(0);
      try {
        const run = await runFrom(repoDirectory, ["upgrade"]);

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("another user's environment");
        expect(run.stderr).not.toContain("source checkout");
      } finally {
        geteuid.mockRestore();
      }
    });
  });

  it("refuses a version together with --rollback before looking anything up", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const run = await runFrom(repoDirectory, [
        "upgrade",
        "--rollback",
        "4.8.0",
      ]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("--rollback takes no version");
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
      expect(run.stdout).toMatch(
        /^\s*\$ \S+ \S+\/node_modules\/skills\/bin\/cli\.mjs list --json \(exit 0\)$/m,
      );
      expect(run.stdout).toMatch(/^\s*│ /m);
    });
  });
});

describe("agemon plan → agemon apply --plan", () => {
  beforeEach(() => {
    resetFakeSubprocessState();
  });

  function planIdFrom(run: CliRun): string {
    const match = /plans\/([0-9a-f]{16})\.json/u.exec(run.stdout);
    if (match === null) {
      throw new Error(`no plan id in output:\n${run.stdout}`);
    }
    return match[1];
  }

  async function installedSkillNames(repoDirectory: string): Promise<string[]> {
    const ledger = JSON.parse(
      await readFile(join(repoDirectory, ".agemon/state.json"), "utf8"),
    ) as { actions: { type: string; target: string }[] };
    return ledger.actions
      .filter((action) => action.type === "installed-skill")
      .map((action) => action.target);
  }

  it("installs only the reviewed groups, although --yes alone would install every group", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const planned = await runFrom(repoDirectory, ["plan"]);
      expect(planned.stdout).toContain("skill-group:essentials");
      expect(planned.stdout).not.toContain("skill-group:design");

      const applied = await runFrom(repoDirectory, [
        "apply",
        "--plan",
        planIdFrom(planned),
        "--yes",
      ]);

      expect(applied.exitCode).toBe(0);
      expect((await installedSkillNames(repoDirectory)).sort()).toEqual([
        "web-design-guidelines",
        "writing-guidelines",
      ]);
    });
  });

  it("applies a plan made with --skill-groups when apply gets the same option", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const planned = await runFrom(repoDirectory, [
        "--skill-groups",
        "security",
        "plan",
      ]);
      expect(planned.stdout).toContain("skill-group:security");

      const applied = await runFrom(repoDirectory, [
        "--skill-groups",
        "security",
        "apply",
        "--plan",
        planIdFrom(planned),
        "--yes",
      ]);

      expect(applied.exitCode).toBe(0);
      expect(await installedSkillNames(repoDirectory)).toContain(
        "agemon-security",
      );
    });
  });

  it("refuses, naming the skill groups, when apply runs with different options", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const planned = await runFrom(repoDirectory, [
        "--skill-groups",
        "security",
        "plan",
      ]);

      const applied = await runFrom(repoDirectory, [
        "apply",
        "--plan",
        planIdFrom(planned),
        "--yes",
      ]);

      expect(applied.exitCode).toBe(1);
      expect(applied.stderr.replace(/[\s│]+/gu, " ")).toContain(
        `Plan ${planIdFrom(planned)} was made with "security" skill groups; this run has the default. Run 'agemon plan' again with the options you want, review it, then apply that plan.`,
      );
      expect(await exists(join(repoDirectory, ".agemon/state.json"))).toBe(
        false,
      );
    });
  });
});

describe("an invalid agemon.toml in status and inspect", () => {
  const INVALID_CONFIG = 'capabilities = ["skills"]\nskill_group = "x"\n';

  it("status reports it and exits 2, even with no agemon state", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(join(repoDirectory, "agemon.toml"), INVALID_CONFIG);

      const status = await runFrom(repoDirectory, ["status"]);

      expect(status.exitCode).toBe(DRIFT_EXIT_CODE);
      expect(status.stdout).toContain(
        "agemon.toml is invalid: unknown key 'skill_group'.",
      );
    });
  });

  it("inspect --json carries it as configError and still exits 0", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(join(repoDirectory, "agemon.toml"), INVALID_CONFIG);

      const inspect = await runFrom(repoDirectory, ["inspect", "--json"]);

      expect(inspect.exitCode).toBe(0);
      expect(JSON.parse(inspect.stdout).configError).toMatch(
        /^agemon\.toml is invalid: unknown key 'skill_group'\./u,
      );
    });
  });
});

describe("adding the agents capability to an existing agemon.toml", () => {
  const PRE_AGENTS_CONFIG =
    '# team config\ncapabilities = ["crg", "daemon", "skills", "master-prompt"]\n';

  async function readConfig(repoDirectory: string): Promise<string> {
    return readFile(join(repoDirectory, "agemon.toml"), "utf8");
  }

  it("includes agents, then records it once with a backup of the original", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(join(repoDirectory, "agemon.toml"), PRE_AGENTS_CONFIG);

      const run = await runFrom(repoDirectory, ["--yes", "--skip-daemon"]);

      expect(run.exitCode).toBe(0);
      expect(run.stderr).toContain(
        "agemon.toml does not list the new capability 'agents' (installs Claude Code subagents for your skill groups) yet; this run includes it (agemon.toml is updated when this run completes).",
      );
      expect(run.stdout).toContain(
        "Updated agemon.toml: added 'agents' (installs Claude Code subagents for your skill groups) to capabilities; remove it there to opt out. Comments and layout were not kept; the original is saved at .agemon/backups/",
      );
      const rewritten = await readConfig(repoDirectory);
      expect(rewritten).toContain(
        'capabilities = [ "crg", "daemon", "skills", "master-prompt", "agents" ]',
      );
      expect(rewritten).toContain("known_capabilities = [");
      expect(
        await exists(
          join(repoDirectory, ".claude/agents/geo-audit-technical.md"),
        ),
      ).toBe(true);
    });
  });

  it("keeps agents out once the user removes it after the rewrite", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(join(repoDirectory, "agemon.toml"), PRE_AGENTS_CONFIG);
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);
      const optedOut = (await readConfig(repoDirectory)).replace(
        ', "agents" ]',
        " ]",
      );
      await writeFile(join(repoDirectory, "agemon.toml"), optedOut);

      const run = await runFrom(repoDirectory, ["--yes"]);

      expect(run.stderr).not.toContain("new capability");
      expect(await readConfig(repoDirectory)).toBe(optedOut);
    });
  });

  it.each([
    ["a dry run", ["--dry-run"]],
    ["a run without consent", []],
    ["an explicit --only", ["--yes", "--only", "crg"]],
  ])("never rewrites agemon.toml in %s", async (_label, argv) => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      await writeFile(join(repoDirectory, "agemon.toml"), PRE_AGENTS_CONFIG);

      await runFrom(repoDirectory, argv);

      expect(await readConfig(repoDirectory)).toBe(PRE_AGENTS_CONFIG);
    });
  });

  it("writes known_capabilities into a new agemon.toml", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      expect((await runFrom(repoDirectory, ["--yes"])).exitCode).toBe(0);

      expect(await readConfig(repoDirectory)).toContain(
        'known_capabilities = [ "crg", "daemon", "skills", "agents", "cli-tool", "master-prompt" ]',
      );
    });
  });
});

describe("plan then apply --plan with subagents", () => {
  async function planId(
    runFrom: FixtureRepo["runFrom"],
    repoDirectory: string,
  ): Promise<string> {
    const run = await runFrom(repoDirectory, [
      "plan",
      "--skill-groups",
      "geo-seo",
    ]);
    const id = /\.agemon\/plans\/([0-9a-f]+)\.json/u.exec(run.stdout)?.[1];
    if (id === undefined) {
      throw new Error(`no plan id in: ${run.stdout}`);
    }
    return id;
  }

  it("installs exactly the planned agents", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const id = await planId(runFrom, repoDirectory);

      const run = await runFrom(repoDirectory, [
        "apply",
        "--plan",
        id,
        "--skill-groups",
        "geo-seo",
        "--yes",
      ]);

      expect(run.exitCode).toBe(0);
      expect(
        await exists(join(repoDirectory, ".claude/agents/geo-audit-schema.md")),
      ).toBe(true);
    });
  });

  it("refuses a stored plan whose skill group operation was edited", async () => {
    await withCleanRepo(async ({ repoDirectory, runFrom }) => {
      const id = await planId(runFrom, repoDirectory);
      const planPath = join(repoDirectory, ".agemon/plans", `${id}.json`);
      await writeFile(
        planPath,
        (await readFile(planPath, "utf8")).replace(
          '"skill-group:geo-seo"',
          '"skill-group:security"',
        ),
      );

      const run = await runFrom(repoDirectory, [
        "apply",
        "--plan",
        id,
        "--skill-groups",
        "geo-seo",
        "--yes",
      ]);

      expect(run.exitCode).toBe(1);
      expect(await exists(join(repoDirectory, ".claude/agents"))).toBe(false);
    });
  });
});
