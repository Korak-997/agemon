import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliEntry,
  createFakeBinariesDirectory,
  fixturesRoot,
  tsxBin,
} from "./cli-harness.js";

const createdTempDirectories: string[] = [];
const CLI_TIMEOUT_MS = 30_000;

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createGitRepositorySandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), "agemon-untrusted-config-"));
  createdTempDirectories.push(sandbox);
  const repository = join(sandbox, "repo");
  await cp(join(fixturesRoot, "clean-repo"), repository, { recursive: true });
  execFileSync("git", ["init", "-q", repository]);
  const osRelease = join(sandbox, "os-release");
  await mkdir(join(sandbox, "home"), { recursive: true });
  await writeFile(osRelease, "ID=ubuntu\n");
  const fakeBinaries = await createFakeBinariesDirectory(sandbox);
  const gitConfig = (key: string, value: string) =>
    execFileSync("git", ["-C", repository, "config", key, value]);
  const agemon = (...argv: string[]) => {
    const result = spawnSync(tsxBin, [cliEntry, ...argv], {
      cwd: repository,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: join(sandbox, "home"),
        XDG_STATE_HOME: join(sandbox, "state"),
        PATH: `${fakeBinaries}${delimiter}${process.env.PATH ?? ""}`,
        AGEMON_DEV: "1",
        AGEMON_FAKE_SUBPROCESS: "1",
        AGEMON_FAKE_SERVICES: "1",
        AGEMON_OS_RELEASE_PATH: osRelease,
        NO_COLOR: "1",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    return {
      status: result.status,
      output,
      unwrapped: output.replace(/[│\s]+/g, " "),
    };
  };
  return { gitConfig, agemon };
}

describe("agemon in a repository whose git config names a program", () => {
  it(
    "skips crg and the daemon, says why, and exits 2",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      gitConfig("diff.x.command", "/tmp/differ");

      const run = agemon("--yes", "--only", "crg,daemon");

      expect(run.status, run.output).toBe(2);
      expect(run.unwrapped).toContain(
        "code-review-graph — untrusted repository git config (approve interactively or pass --yes --trust-repo-git-config): .git/config: diff.x.command=/tmp/differ",
      );
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "with --yes --trust-repo-git-config, prints every pair and installs crg and the daemon",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      gitConfig("diff.x.command", "/tmp/differ");

      const run = agemon(
        "--yes",
        "--trust-repo-git-config",
        "--only",
        "crg,daemon",
      );

      expect(run.status, run.output).toBe(0);
      expect(run.unwrapped).toContain(
        "code-review-graph and its daemon will run git here with these repository settings, which agemon does not trust by default:",
      );
      expect(run.unwrapped).toContain(
        ".git/config: diff.x.command=/tmp/differ",
      );
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "under --yes without the flag, names the redacted pairs in the skip reason and never a raw secret",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      gitConfig(
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic eDphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng==",
      );

      const run = agemon("--yes", "--only", "crg", "--skip-daemon");

      expect(run.status, run.output).toBe(2);
      expect(run.unwrapped).toContain(
        "approve interactively or pass --yes --trust-repo-git-config): .git/config: http.https://github.com/.extraheader=AUTHORIZATION: basic <redacted:",
      );
      expect(run.output).not.toContain("eDphYmNk");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "applies a stored plan with --yes --trust-repo-git-config when the config is unchanged",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      gitConfig("diff.x.command", "/tmp/differ");
      const plan = agemon("plan", "--only", "crg");
      const planId = /plans\/([0-9a-f]{16})\.json/.exec(plan.output)?.[1];
      expect(planId, plan.output).toBeDefined();

      const run = agemon(
        "apply",
        "--plan",
        planId as string,
        "--yes",
        "--trust-repo-git-config",
        "--only",
        "crg",
      );

      expect(run.status, run.output).toBe(0);
      expect(run.unwrapped).toContain(
        ".git/config: diff.x.command=/tmp/differ",
      );
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "applies crg normally when the config holds only allowlisted keys",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      gitConfig("pull.rebase", "true");

      const run = agemon("--yes", "--only", "crg", "--skip-daemon");

      expect(run.status, run.output).toBe(0);
      expect(run.output).not.toContain("untrusted repository git config");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "makes status need attention, exiting 2, once a program-naming key appears after install",
    async () => {
      const { gitConfig, agemon } = await createGitRepositorySandbox();
      expect(agemon("--yes", "--only", "crg", "--skip-daemon").status).toBe(0);
      gitConfig("diff.x.command", "/tmp/differ");

      const status = agemon("status");

      expect(status.status, status.output).toBe(2);
      expect(status.unwrapped).toContain(
        "this repository's git config has keys agemon does not trust by default: .git/config: diff.x.command=/tmp/differ",
      );
    },
    CLI_TIMEOUT_MS,
  );
});
