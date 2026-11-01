import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  watch,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { runCli } from "../src/cli/index.js";
import { takeFakeVerifiedBinaryInstallRequests } from "../src/core/fake-subprocess.js";
import { quoteForShlex } from "../src/core/untrusted-text.js";
import { AGNIX_VERSION } from "../src/plugins/pins.js";
import {
  buildAgemonArgv,
  buildRunArgv,
  type RunFlags,
} from "./sandbox/argv.js";
import {
  type DiffLine,
  diffSnapshots,
  formatDiff,
  type Snapshot,
  snapshotTree,
} from "./sandbox/snapshot.js";

const REPO_ROOT = process.cwd();
const SANDBOX_ROOT = join(REPO_ROOT, ".sandbox");
const RUNS_DIR = join(SANDBOX_ROOT, "runs");
const FIXTURES_DIR = join(REPO_ROOT, "test/fixtures");
const SANDBOX_NAME_PATTERN = /^[a-z0-9-]+$/u;
const ISOLATED_GIT_ENVIRONMENT = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const FIXTURE_COMMIT_GIT_OPTIONS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "user.name=agemon",
  "-c",
  "user.email=recording@example.invalid",
];

function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = {
    dryRun: false,
    real: false,
    trace: false,
    quiet: false,
    skipDaemon: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--real") flags.real = true;
    else if (arg === "--trace") flags.trace = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--skip-daemon") flags.skipDaemon = true;
    else if (arg === "--only") {
      i += 1;
      flags.only = args[i];
    } else if (arg === "--skill-groups") {
      i += 1;
      flags.skillGroups = args[i];
    } else if (arg === "--label") {
      i += 1;
      flags.label = args[i];
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

function buildNukeArgv(flags: RunFlags): string[] {
  const argv = ["nuke", "--yes"];
  if (flags.only) argv.push("--only", flags.only);
  if (flags.skipDaemon) argv.push("--skip-daemon");
  return argv;
}

function defaultLabel(): string {
  return new Date().toISOString().toLowerCase().replace(/[:.]/g, "-");
}

function assertSandboxName(kind: "fixture" | "label", value: string): void {
  if (!SANDBOX_NAME_PATTERN.test(value)) {
    throw new Error(
      `The ${kind} ${JSON.stringify(value)} may use only a-z, 0-9 and -`,
    );
  }
}

async function prepareRun(
  runsDir: string,
  fixture: string,
  label: string,
): Promise<{ runDir: string; repoDir: string; homeDir: string }> {
  assertSandboxName("fixture", fixture);
  assertSandboxName("label", label);
  const fixtureDir = join(FIXTURES_DIR, fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(`Unknown fixture: ${fixture} (expected ${fixtureDir})`);
  }

  const runDir = join(runsDir, label);
  const repoDir = join(runDir, "repo");
  const homeDir = join(runDir, "home");

  await rm(runDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await cp(fixtureDir, repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], {
    cwd: repoDir,
    stdio: "ignore",
    env: ISOLATED_GIT_ENVIRONMENT,
  });

  return { runDir, repoDir, homeDir };
}

function setOrDeleteEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withCapturedOutput(
  action: () => Promise<number>,
): Promise<{ exitCode: number; output: string }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutIsTty = process.stdout.isTTY;
  const originalStderrIsTty = process.stderr.isTTY;

  let output = "";
  const capture = (chunk: string | Uint8Array): boolean => {
    output +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  process.stdout.isTTY = false;
  process.stderr.isTTY = false;

  try {
    const exitCode = await action();
    return { exitCode, output };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.stdout.isTTY = originalStdoutIsTty;
    process.stderr.isTTY = originalStderrIsTty;
  }
}

function sandboxEnvironment(
  repoDir: string,
  homeDir: string,
  real: boolean,
  fixture: string,
): Record<string, string | undefined> {
  const fixtureOsReleasePath = join(repoDir, ".sandbox", "os-release");
  return {
    HOME: homeDir,
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    AGEMON_DEV: "1",
    AGEMON_FAKE_SUBPROCESS: real ? undefined : "1",
    AGEMON_FAKE_SERVICES: real ? undefined : "1",
    AGEMON_FAKE_PREINSTALLED_CRG:
      !real && fixture === "preexisting-crg" ? "1" : undefined,
    AGEMON_OS_RELEASE_PATH: existsSync(fixtureOsReleasePath)
      ? fixtureOsReleasePath
      : undefined,
  };
}

async function invokeAgemon(
  argv: string[],
  repoDir: string,
  homeDir: string,
  real: boolean,
  fixture: string,
): Promise<{ exitCode: number; output: string }> {
  const originalCwd = process.cwd();
  const environment = sandboxEnvironment(repoDir, homeDir, real, fixture);
  const originalEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );

  process.chdir(repoDir);
  for (const [name, value] of Object.entries(environment)) {
    setOrDeleteEnv(name, value);
  }

  try {
    return await withCapturedOutput(() => runCli(argv));
  } finally {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnvironment)) {
      setOrDeleteEnv(name, value);
    }
  }
}

async function printManifest(repoDir: string): Promise<void> {
  const manifestPath = join(repoDir, ".agemon", "state.json");
  if (!existsSync(manifestPath)) return;

  const contents = await readFile(manifestPath, "utf8");
  console.log("\n.agemon/state.json:");
  console.log(JSON.stringify(JSON.parse(contents), null, 2));
}

function printDiff(label: string, before: Snapshot, after: Snapshot): void {
  console.log(`\nRun: ${label}`);
  console.log(formatDiff(diffSnapshots(before, after)));
}

async function cmdRun(fixture: string, flags: RunFlags): Promise<void> {
  const label = flags.label ?? defaultLabel();
  const { runDir, repoDir, homeDir } = await prepareRun(
    RUNS_DIR,
    fixture,
    label,
  );

  const before = await snapshotTree(runDir);
  const { exitCode, output } = await invokeAgemon(
    buildRunArgv(flags),
    repoDir,
    homeDir,
    flags.real,
    fixture,
  );
  const after = await snapshotTree(runDir);

  printDiff(label, before, after);
  await printManifest(repoDir);

  if (!flags.quiet) {
    console.log("\nTerminal output:");
    console.log(output);
  }

  if (exitCode !== 0) {
    throw new Error(`agemon exited with code ${exitCode}`);
  }
}

const SKILLS_TOOLS_CACHE_DIRECTORY = "home/.local/state/agemon/tools/";
const KEPT_MACHINE_CACHE_DIRECTORIES = [
  SKILLS_TOOLS_CACHE_DIRECTORY,
  "home/.local/state/agemon/skills-src/",
];

const KEPT_MACHINE_STATE_FILES = ["home/.local/state/agemon/ledger-key"];

function isKeptMachineCacheFile(line: DiffLine): boolean {
  return (
    line.kind === "added" &&
    (KEPT_MACHINE_CACHE_DIRECTORIES.some((directory) =>
      line.path.startsWith(directory),
    ) ||
      KEPT_MACHINE_STATE_FILES.includes(line.path))
  );
}

function isSkillsToolsCacheFile(line: DiffLine): boolean {
  return line.path.startsWith(SKILLS_TOOLS_CACHE_DIRECTORY);
}

function pluginRan(flags: RunFlags, pluginId: string): boolean {
  return (
    !flags.only ||
    flags.only
      .split(",")
      .map((selectedPluginId) => selectedPluginId.trim())
      .includes(pluginId)
  );
}

async function assertEssentialsStatusIsCurrent(
  repoDir: string,
  homeDir: string,
  fixture: string,
): Promise<void> {
  const status = await invokeAgemon(
    ["status"],
    repoDir,
    homeDir,
    false,
    fixture,
  );
  const skillRows = status.output
    .split("\n")
    .filter((line) => line.trimStart().startsWith("skills "));
  const everyGroupIsCurrent =
    skillRows.length > 0 &&
    skillRows.every(
      (line) =>
        line.includes("present · managed") &&
        !line.includes("update available"),
    );
  if (!everyGroupIsCurrent) {
    throw new Error(
      `roundtrip failed — status after the fake install does not report every skill group, Essentials included, as current:\n${status.output}`,
    );
  }
}

async function cmdRoundtrip(fixture: string, flags: RunFlags): Promise<void> {
  const label = flags.label ?? defaultLabel();
  const { runDir, repoDir, homeDir } = await prepareRun(
    RUNS_DIR,
    fixture,
    label,
  );

  const beforeInstall = await snapshotTree(runDir);

  takeFakeVerifiedBinaryInstallRequests();
  const install = await invokeAgemon(
    ["--yes", ...buildAgemonArgv({ ...flags, dryRun: false })],
    repoDir,
    homeDir,
    flags.real,
    fixture,
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `install exited with code ${install.exitCode}:\n${install.output}`,
    );
  }
  const verifiedBinaryInstalls = takeFakeVerifiedBinaryInstallRequests();
  if (!flags.real && pluginRan(flags, "skills")) {
    await assertEssentialsStatusIsCurrent(repoDir, homeDir, fixture);
  }

  const nuke = await invokeAgemon(
    buildNukeArgv(flags),
    repoDir,
    homeDir,
    flags.real,
    fixture,
  );
  if (nuke.exitCode !== 0) {
    throw new Error(`nuke exited with code ${nuke.exitCode}:\n${nuke.output}`);
  }

  const afterNuke = await snapshotTree(runDir);
  const fullDiff = diffSnapshots(beforeInstall, afterNuke);
  const keptMachineCache = fullDiff.filter(isKeptMachineCacheFile);
  const diff = fullDiff.filter((line) => !isKeptMachineCacheFile(line));

  console.log(`\nRoundtrip: ${label}`);
  if (
    !flags.real &&
    pluginRan(flags, "skills") &&
    !keptMachineCache.some(isSkillsToolsCacheFile)
  ) {
    throw new Error(
      "roundtrip failed — skills calls did not go through the pinned tools dir",
    );
  }
  if (
    !flags.real &&
    pluginRan(flags, "cli-tool") &&
    !verifiedBinaryInstalls.some(
      (request) =>
        request.packageName === "agnix" && request.version === AGNIX_VERSION,
    )
  ) {
    throw new Error(
      "roundtrip failed — agnix did not go through the verified binary installer",
    );
  }
  if (diff.length === 0) {
    console.log("✔ byte-identical to pre-install state");
    return;
  }

  console.log("✘ tree differs from pre-install state:");
  console.log(formatDiff(diff));
  throw new Error(
    "roundtrip failed — tree is not byte-identical, see diff above",
  );
}

async function assertUsableRunsRoot(runsRoot: string): Promise<void> {
  if (!isAbsolute(runsRoot)) {
    throw new Error(`--runs-root must be an absolute path: ${runsRoot}`);
  }
  const resolvedRunsRoot = await realpath(runsRoot).catch(() => null);
  if (resolvedRunsRoot === null) {
    throw new Error(
      `--runs-root must be an existing, empty directory: ${runsRoot}`,
    );
  }
  const fromRepository = relative(await realpath(REPO_ROOT), resolvedRunsRoot);
  const outsideRepository =
    fromRepository === ".." ||
    fromRepository.startsWith(`..${sep}`) ||
    isAbsolute(fromRepository);
  if (!outsideRepository) {
    throw new Error(
      `--runs-root must be outside the repository, so nothing a recording writes can land in it: ${runsRoot}`,
    );
  }
  if ((await readdir(resolvedRunsRoot)).length > 0) {
    throw new Error(
      `--runs-root must be an existing, empty directory: ${runsRoot}`,
    );
  }
}

function commitFixture(repoDir: string): void {
  for (const args of [
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", [...FIXTURE_COMMIT_GIT_OPTIONS, ...args], {
      cwd: repoDir,
      stdio: "ignore",
      env: ISOLATED_GIT_ENVIRONMENT,
    });
  }
}

async function cmdPrepare(fixture: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      label: { type: "string" },
      "runs-root": { type: "string" },
      "shell-runs-root": { type: "string" },
    },
  });
  if (values.label === undefined) {
    throw new Error("prepare needs --label <label>");
  }
  if (values["runs-root"] === undefined) {
    throw new Error("prepare needs --runs-root <empty directory>");
  }
  await assertUsableRunsRoot(values["runs-root"]);
  const shellRunsRoot = values["shell-runs-root"] ?? values["runs-root"];
  if (!isAbsolute(shellRunsRoot)) {
    throw new Error(
      `--shell-runs-root must be an absolute path: ${shellRunsRoot}`,
    );
  }

  const { runDir, repoDir, homeDir } = await prepareRun(
    values["runs-root"],
    fixture,
    values.label,
  );
  commitFixture(repoDir);

  const shellRunDir = join(shellRunsRoot, values.label);
  const asSeenByShell = (path: string): string =>
    path.startsWith(runDir) ? shellRunDir + path.slice(runDir.length) : path;
  const environment = sandboxEnvironment(repoDir, homeDir, false, fixture);
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined)
      console.log(`export ${name}=${quoteForShlex(asSeenByShell(value))}`);
  }
  console.log(`cd ${quoteForShlex(asSeenByShell(repoDir))}`);
}

async function cmdReset(): Promise<void> {
  await rm(SANDBOX_ROOT, { recursive: true, force: true });
  console.log("Wiped .sandbox/");
}

async function cmdWatch(fixture: string, flags: RunFlags): Promise<void> {
  const srcDir = join(REPO_ROOT, "src");
  console.log(
    `Watching ${srcDir} — re-running sandbox against '${fixture}' on save. Ctrl+C to stop.`,
  );

  let running = false;
  let rerunQueued = false;

  const runOnce = async (): Promise<void> => {
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    try {
      await cmdRun(fixture, { ...flags, label: "watch" });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        await runOnce();
      }
    }
  };

  await runOnce();

  const watcher = watch(srcDir, { recursive: true });
  for await (const _event of watcher) {
    void runOnce();
  }
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "reset") {
    await cmdReset();
    return;
  }

  if (mode === "prepare") {
    const [fixture, ...flagArgs] = rest;
    if (!fixture) {
      throw new Error(
        "Usage: npm run sandbox -- prepare <fixture> --label <label> --runs-root <empty directory>",
      );
    }
    await cmdPrepare(fixture, flagArgs);
    return;
  }

  if (mode === "run" || mode === "roundtrip" || mode === "watch") {
    const [fixture, ...flagArgs] = rest;
    if (!fixture) {
      throw new Error(`Usage: npm run sandbox -- ${mode} <fixture> [flags]`);
    }
    const flags = parseFlags(flagArgs);

    if (mode === "run") await cmdRun(fixture, flags);
    else if (mode === "roundtrip") await cmdRoundtrip(fixture, flags);
    else await cmdWatch(fixture, flags);
    return;
  }

  throw new Error(
    `Usage: npm run sandbox -- <run|roundtrip|prepare|reset> <fixture> [flags]`,
  );
}

await main();
