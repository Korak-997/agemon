import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { REQUIRED_BINARIES } from "../../src/platform/detect.js";

export const repoRoot = process.cwd();
export const fixturesRoot = join(repoRoot, "test/fixtures");
export const cliEntry = join(repoRoot, "src/cli/index.ts");
export const tsxBin = join(repoRoot, "node_modules/.bin/tsx");

export async function createFakeBinariesDirectory(
  sandboxDirectory: string,
  extraBinaryNames: string[] = [],
): Promise<string> {
  const fakeBinariesDirectory = join(sandboxDirectory, "fake-bin");
  await mkdir(fakeBinariesDirectory, { recursive: true });

  for (const binaryName of [...REQUIRED_BINARIES, ...extraBinaryNames]) {
    await writeFile(
      join(fakeBinariesDirectory, binaryName),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
  }

  return fakeBinariesDirectory;
}

export function normalize(output: string, repoDirectory: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return output
    .replaceAll(repoDirectory, "<REPO>")
    .replace(ansiPattern, "")
    .replace(/\bPlan [0-9a-f]{12,}\b/g, "Plan <PLAN_ID>")
    .replace(/plans\/[0-9a-f]{12,}\.json/g, "plans/<PLAN_ID>.json")
    .replace(/--plan [0-9a-f]{12,}\b/g, "--plan <PLAN_ID>")
    .replace(/\bagemon \d+\.\d+\.\d+/g, "agemon <VERSION>")
    .replace(/ present \([^)]*\)/g, " present (<PATH>)")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<TIMESTAMP>")
    .replace(/ \d+\.\d+s\b/g, " <ELAPSED>")
    .trimEnd();
}

export interface CaptureNonInteractiveRunOptions {
  extraBinaryNames?: string[];
  env?: Record<string, string>;
}

const EXIT_LINE_PATTERN = /^exit \d+\n/;

export function parseJsonOutput(output: string): unknown {
  return JSON.parse(output.replace(EXIT_LINE_PATTERN, ""));
}

export async function captureNonInteractiveRun(
  fixtureName: string,
  argv: string[],
  sandboxDirectory: string,
  options: CaptureNonInteractiveRunOptions = {},
): Promise<string> {
  const repoDirectory = join(sandboxDirectory, "repo");
  const homeDirectory = join(sandboxDirectory, "home");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, { recursive: true });

  const fixtureOsReleasePath = join(repoDirectory, ".sandbox", "os-release");
  await mkdir(join(repoDirectory, ".sandbox"), { recursive: true });
  await writeFile(fixtureOsReleasePath, "ID=ubuntu\n", "utf8");

  const fakeBinariesDirectory = await createFakeBinariesDirectory(
    sandboxDirectory,
    options.extraBinaryNames,
  );

  const result = spawnSync(tsxBin, [cliEntry, ...argv], {
    cwd: repoDirectory,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: homeDirectory,
      PATH: `${fakeBinariesDirectory}${delimiter}${process.env.PATH ?? ""}`,
      AGEMON_DEV: "1",
      AGEMON_FAKE_SUBPROCESS: "1",
      AGEMON_FAKE_SERVICES: "1",
      AGEMON_OS_RELEASE_PATH: fixtureOsReleasePath,
      NO_COLOR: "1",
      ...options.env,
    },
  });

  if (result.error || result.signal) {
    throw new Error(
      `CLI subprocess failed to complete (error: ${result.error}, signal: ${result.signal})`,
    );
  }

  const merged = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return `exit ${result.status}\n${normalize(merged, repoDirectory)}`;
}
