import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createMachine() {
  const sandbox = await mkdtemp(join(tmpdir(), "agemon-shared-"));
  createdTempDirectories.push(sandbox);
  const home = join(sandbox, "home");
  const stateRoot = join(sandbox, "state");
  const osReleasePath = join(sandbox, "os-release");
  await mkdir(home);
  await writeFile(osReleasePath, "ID=ubuntu\n", "utf8");
  const fakeBinaries = await createFakeBinariesDirectory(sandbox);

  const repository = async (name: string): Promise<string> => {
    const repo = join(sandbox, name);
    await cp(join(fixturesRoot, "clean-repo"), repo, { recursive: true });
    return repo;
  };

  const agemon = (repo: string, argv: string[]) => {
    const result = spawnSync(tsxBin, [cliEntry, ...argv], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: stateRoot,
        PATH: `${fakeBinaries}${delimiter}${process.env.PATH ?? ""}`,
        AGEMON_DEV: "1",
        AGEMON_FAKE_SUBPROCESS: "1",
        AGEMON_FAKE_SERVICES: "1",
        AGEMON_OS_RELEASE_PATH: osReleasePath,
        NO_COLOR: "1",
      },
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  };

  const crgInstalled = () =>
    existsSync(
      join(home, ".agemon", "fake-pipx", "venvs", "code-review-graph"),
    );
  const agnixInstalled = async () => {
    const statePath = join(stateRoot, "agemon-fake", "npm-global.json");
    return (
      existsSync(statePath) &&
      (JSON.parse(await readFile(statePath, "utf8")) as string[]).includes(
        "agnix",
      )
    );
  };
  const machineLedgerPath = join(stateRoot, "agemon", "machine.json");
  const lingerOn = () => existsSync(join(home, ".agemon", "fake-linger"));

  return {
    repository,
    agemon,
    crgInstalled,
    agnixInstalled,
    machineLedgerPath,
    lingerOn,
    stateRoot,
  };
}

const INSTALL_SHARED_TOOLS = ["--yes", "--only", "crg,cli-tool"];

describe("shared tools across repositories", () => {
  it("install in A and B; nuke B keeps crg and agnix; nuke A removes them", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");

    expect(machine.agemon(a, INSTALL_SHARED_TOOLS).status).toBe(0);
    expect(
      machine.agemon(b, ["plan", "--only", "crg,cli-tool"]).output,
    ).toContain("record that this repository uses code-review-graph");
    expect(machine.agemon(b, INSTALL_SHARED_TOOLS).status).toBe(0);
    expect(machine.crgInstalled()).toBe(true);
    expect(await machine.agnixInstalled()).toBe(true);

    const nukeB = machine.agemon(b, ["nuke", "--yes"]);
    expect(nukeB.status).toBe(0);
    expect(nukeB.output).toContain("Keeping code-review-graph: still used by");
    expect(machine.crgInstalled()).toBe(true);
    expect(await machine.agnixInstalled()).toBe(true);

    expect(machine.agemon(a, ["nuke", "--yes"]).status).toBe(0);
    expect(machine.crgInstalled()).toBe(false);
    expect(await machine.agnixInstalled()).toBe(false);
  }, 60_000);

  it("two repositories with daemons: nuke one keeps linger, nuke the installer disables it", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    const withDaemon = ["--yes", "--only", "crg,daemon"];

    expect(machine.agemon(a, withDaemon).status).toBe(0);
    expect(machine.agemon(b, withDaemon).status).toBe(0);
    expect(machine.lingerOn()).toBe(true);

    expect(machine.agemon(b, ["nuke", "--yes"]).status).toBe(0);
    expect(machine.lingerOn()).toBe(true);
    expect(machine.agemon(a, ["nuke", "--yes"]).status).toBe(0);
    expect(machine.lingerOn()).toBe(false);
  }, 60_000);

  it("status lists the shared tools and their users", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    machine.agemon(a, INSTALL_SHARED_TOOLS);
    machine.agemon(b, INSTALL_SHARED_TOOLS);

    const status = machine.agemon(b, ["status"]);

    expect(status.output).toContain("Shared tools");
    expect(status.output).toContain("code-review-graph (installed)");
    expect(status.output).toContain("(this repository)");
  }, 60_000);

  it("status changes nothing in machine.json and only marks a missing user", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    const b = await machine.repository("b");
    machine.agemon(a, INSTALL_SHARED_TOOLS);
    machine.agemon(b, INSTALL_SHARED_TOOLS);
    await rm(b, { recursive: true });
    const before = await readFile(machine.machineLedgerPath, "utf8");

    const status = machine.agemon(a, ["status"]);

    expect(status.output).toContain("(missing — dropped on the next change)");
    expect(await readFile(machine.machineLedgerPath, "utf8")).toBe(before);
  }, 60_000);

  it("a repository with a pre-P8 ledger migrates: use-shared line, kept without --remove-shared, removed with it", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    machine.agemon(a, ["--yes", "--only", "crg"]);
    await rm(machine.machineLedgerPath);

    expect(machine.agemon(a, ["plan", "--only", "crg"]).output).toContain(
      "this repository's ledger says agemon installed it",
    );
    expect(machine.agemon(a, ["--yes", "--only", "crg"]).status).toBe(0);
    const preview = machine.agemon(a, ["nuke", "--dry-run"]);
    expect(preview.output).toContain(
      "Re-run with --remove-shared code-review-graph",
    );
    expect(machine.crgInstalled()).toBe(true);

    const nuke = machine.agemon(a, [
      "nuke",
      "--yes",
      "--remove-shared",
      "code-review-graph",
    ]);
    expect(nuke.status).toBe(0);
    expect(machine.crgInstalled()).toBe(false);
  }, 60_000);

  it("a forged state.json in a fresh clone removes nothing on nuke", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    machine.agemon(a, INSTALL_SHARED_TOOLS);
    const clone = await machine.repository("clone");
    await mkdir(join(clone, ".agemon"));
    await cp(
      join(a, ".agemon", "state.json"),
      join(clone, ".agemon", "state.json"),
    );

    const nuke = machine.agemon(clone, [
      "nuke",
      "--yes",
      "--remove-shared",
      "code-review-graph,agnix",
    ]);

    expect(nuke.output).toContain(
      "Keeping code-review-graph: this repository is not registered as using it",
    );
    expect(nuke.output).toContain(
      "Keeping agnix: this repository is not registered as using it",
    );
    expect(machine.crgInstalled()).toBe(true);
    expect(await machine.agnixInstalled()).toBe(true);
  }, 60_000);

  it("a run in progress blocks nuke, recover and agemon before the ledger is read; dry runs take no lock", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");
    machine.agemon(a, INSTALL_SHARED_TOOLS);
    const key = createHash("sha256")
      .update(await realpath(a))
      .digest("hex")
      .slice(0, 16);
    const runsDirectory = join(machine.stateRoot, "agemon", "runs");
    await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(runsDirectory, `${key}.lock`),
      JSON.stringify({
        token: "another-run",
        pid: process.pid,
        bootId: null,
        startTime: null,
        acquiredAt: "2026-10-25T00:00:00.000Z",
      }),
    );

    await writeFile(join(a, ".agemon", "state.json"), "{ not json");

    expect(machine.agemon(a, ["nuke", "--dry-run"]).status).toBe(1);
    for (const argv of [["nuke", "--yes"], ["recover", "--yes"], ["--yes"]]) {
      const blocked = machine.agemon(a, argv);
      expect(blocked.status).toBe(1);
      expect(blocked.output).toContain(`pid ${process.pid}`);
      expect(blocked.output).not.toContain("not valid JSON");
    }
    expect(machine.crgInstalled()).toBe(true);
  }, 60_000);

  it("refuses an unknown --remove-shared tool name", async () => {
    const machine = await createMachine();
    const a = await machine.repository("a");

    const nuke = machine.agemon(a, ["nuke", "--remove-shared", "linger"]);

    expect(nuke.status).toBe(1);
    expect(nuke.output).toContain(
      "--remove-shared takes a comma-separated list of:",
    );
  });
});
