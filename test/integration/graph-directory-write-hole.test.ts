import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function createSandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), "agemon-write-hole-"));
  createdTempDirectories.push(sandbox);
  const repository = join(sandbox, "repo");
  const outside = join(sandbox, "outside");
  await cp(join(fixturesRoot, "clean-repo"), repository, { recursive: true });
  await mkdir(outside);
  await mkdir(join(sandbox, "home"));
  execFileSync("git", ["init", "-q", repository]);
  const osRelease = join(sandbox, "os-release");
  await writeFile(osRelease, "ID=ubuntu\n");
  const fakeBinaries = await createFakeBinariesDirectory(sandbox);
  const agemonIn = (directory: string, ...argv: string[]) => {
    const result = spawnSync(tsxBin, [cliEntry, ...argv], {
      cwd: directory,
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
    return `${result.stdout}${result.stderr}`.replace(/[│\s]+/g, " ");
  };
  const agemon = (...argv: string[]) => agemonIn(repository, ...argv);
  const linkGraphDatabaseOutside = async () => {
    await mkdir(join(repository, ".code-review-graph"), { recursive: true });
    await rm(join(repository, ".code-review-graph", "graph.db"), {
      force: true,
    });
    await symlink(
      join(outside, "authorized_keys"),
      join(repository, ".code-review-graph", "graph.db"),
    );
  };
  return { repository, outside, agemon, agemonIn, linkGraphDatabaseOutside };
}

describe("a repository whose .code-review-graph/graph.db links outside it", () => {
  it(
    "agemon refuses the graph build and writes nothing outside the repository",
    async () => {
      const { repository, outside, agemon, linkGraphDatabaseOutside } =
        await createSandbox();
      await linkGraphDatabaseOutside();
      execFileSync("git", ["-C", repository, "add", "-A"]);

      const output = agemon("--yes", "--only", "crg", "--skip-daemon");

      expect(await readdir(outside)).toEqual([]);
      expect(output).toContain(
        "skipped the graph build: 1 path(s) where crg writes its graph are tracked by git",
      );
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "run from a directory whose parent agemon refuses as the repository root, crg builds there and not in the parent",
    async () => {
      const { repository, outside, agemonIn, linkGraphDatabaseOutside } =
        await createSandbox();
      await linkGraphDatabaseOutside();
      await rm(join(repository, ".git"), { recursive: true });
      await writeFile(join(repository, ".git"), "not a gitdir file\n");
      const subdirectory = join(repository, "sub");
      await cp(join(fixturesRoot, "clean-repo"), subdirectory, {
        recursive: true,
      });

      agemonIn(subdirectory, "--yes", "--only", "crg", "--skip-daemon");

      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(join(subdirectory, ".code-review-graph"))).toEqual([
        "graph.db",
      ]);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "agemon status refuses to run code-review-graph status and writes nothing outside the repository",
    async () => {
      const { outside, agemon, linkGraphDatabaseOutside } =
        await createSandbox();
      agemon("--yes", "--only", "crg", "--skip-daemon");
      await linkGraphDatabaseOutside();

      const output = agemon("status");

      expect(await readdir(outside)).toEqual([]);
      expect(output).toContain(
        "crg [ present · managed ] [ unhealthy ] .code-review-graph/graph.db",
      );
    },
    CLI_TIMEOUT_MS,
  );
});
