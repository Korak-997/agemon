import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, watch } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/index.js";
import {
  diffSnapshots,
  formatDiff,
  type Snapshot,
  snapshotTree,
} from "./sandbox/snapshot.js";

const REPO_ROOT = process.cwd();
const SANDBOX_ROOT = join(REPO_ROOT, ".sandbox");
const RUNS_DIR = join(SANDBOX_ROOT, "runs");
const FIXTURES_DIR = join(REPO_ROOT, "test/fixtures");

interface RunFlags {
  dryRun: boolean;
  real: boolean;
  trace: boolean;
  quiet: boolean;
  only?: string;
  label?: string;
}

function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = {
    dryRun: false,
    real: false,
    trace: false,
    quiet: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--real") flags.real = true;
    else if (arg === "--trace") flags.trace = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--only") {
      i += 1;
      flags.only = args[i];
    } else if (arg === "--label") {
      i += 1;
      flags.label = args[i];
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

function buildAgemonArgv(flags: RunFlags): string[] {
  const argv: string[] = [];
  if (flags.dryRun) argv.push("--dry-run");
  if (flags.only) argv.push("--only", flags.only);
  if (flags.quiet) argv.push("--quiet");
  if (flags.trace) argv.push("--verbose");
  return argv;
}

function defaultLabel(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareRun(
  fixture: string,
  label: string,
): Promise<{ runDir: string; repoDir: string; homeDir: string }> {
  const fixtureDir = join(FIXTURES_DIR, fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(`Unknown fixture: ${fixture} (expected ${fixtureDir})`);
  }

  const runDir = join(RUNS_DIR, label);
  const repoDir = join(runDir, "repo");
  const homeDir = join(runDir, "home");

  await rm(runDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await cp(fixtureDir, repoDir, { recursive: true });

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

  // Force the non-TTY rendering path (src/ui/spinner.ts) so the captured
  // output is plain lines rather than an animated spinner's raw ANSI frames
  // — matching what a real user piping `agemon` to a file would see.
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

async function invokeAgemon(
  argv: string[],
  repoDir: string,
  homeDir: string,
  real: boolean,
): Promise<{ exitCode: number; output: string }> {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalDev = process.env.AGEMON_DEV;
  const originalFakeSubprocess = process.env.AGEMON_FAKE_SUBPROCESS;
  const originalFakeServices = process.env.AGEMON_FAKE_SERVICES;
  const originalOsReleasePath = process.env.AGEMON_OS_RELEASE_PATH;
  const fixtureOsReleasePath = join(repoDir, ".sandbox", "os-release");

  process.chdir(repoDir);
  process.env.HOME = homeDir;
  process.env.AGEMON_DEV = "1";
  setOrDeleteEnv("AGEMON_FAKE_SUBPROCESS", real ? undefined : "1");
  setOrDeleteEnv("AGEMON_FAKE_SERVICES", real ? undefined : "1");
  setOrDeleteEnv(
    "AGEMON_OS_RELEASE_PATH",
    existsSync(fixtureOsReleasePath) ? fixtureOsReleasePath : undefined,
  );

  try {
    return await withCapturedOutput(() => runCli(argv));
  } finally {
    process.chdir(originalCwd);
    setOrDeleteEnv("HOME", originalHome);
    setOrDeleteEnv("AGEMON_DEV", originalDev);
    setOrDeleteEnv("AGEMON_FAKE_SUBPROCESS", originalFakeSubprocess);
    setOrDeleteEnv("AGEMON_FAKE_SERVICES", originalFakeServices);
    setOrDeleteEnv("AGEMON_OS_RELEASE_PATH", originalOsReleasePath);
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
  const { runDir, repoDir, homeDir } = await prepareRun(fixture, label);

  const before = await snapshotTree(runDir);
  const { exitCode, output } = await invokeAgemon(
    buildAgemonArgv(flags),
    repoDir,
    homeDir,
    flags.real,
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

async function cmdRoundtrip(fixture: string, flags: RunFlags): Promise<void> {
  const label = flags.label ?? defaultLabel();
  const { runDir, repoDir, homeDir } = await prepareRun(fixture, label);

  const beforeInstall = await snapshotTree(runDir);

  const install = await invokeAgemon(
    buildAgemonArgv({ ...flags, dryRun: false }),
    repoDir,
    homeDir,
    flags.real,
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `install exited with code ${install.exitCode}:\n${install.output}`,
    );
  }

  const nuke = await invokeAgemon(
    ["nuke", "--yes"],
    repoDir,
    homeDir,
    flags.real,
  );
  if (nuke.exitCode !== 0) {
    throw new Error(`nuke exited with code ${nuke.exitCode}:\n${nuke.output}`);
  }

  const afterNuke = await snapshotTree(runDir);
  const diff = diffSnapshots(beforeInstall, afterNuke);

  console.log(`\nRoundtrip: ${label}`);
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
    `Usage: npm run sandbox -- <run|roundtrip|reset> <fixture> [flags]`,
  );
}

await main();
