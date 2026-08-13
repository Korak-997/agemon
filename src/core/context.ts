import { detectPlatform, REQUIRED_BINARIES } from "../platform/detect.js";
import type { StepSpinner } from "../ui/spinner.js";
import { StateManifest } from "./state-manifest.js";
import { runSubprocess, type SubprocessResult } from "./subprocess-runner.js";

export type { SubprocessResult } from "./subprocess-runner.js";

export interface BinaryAvailability {
  name: string;
  present: boolean;
  path?: string;
}

export interface Context {
  cwd: string;
  os: "ubuntu";
  binaries: BinaryAvailability[];
  dryRun: boolean;
  yes: boolean;
  log: Pick<Console, "log" | "error">;
  ui: StepSpinner;
  run: (command: string, args: string[]) => Promise<SubprocessResult>;
  manifest: StateManifest;
}

export interface CreateContextInput {
  dryRun: boolean;
  yes: boolean;
  ui: StepSpinner;
}

export async function createContext(
  input: CreateContextInput,
): Promise<Context> {
  const platform = await detectPlatform({
    osReleasePath: process.env.AGEMON_OS_RELEASE_PATH,
  });

  for (const binaryName of REQUIRED_BINARIES) {
    const binary = platform.binaries[binaryName];
    const status = binary.present
      ? `present (${binary.path ?? "resolved via PATH"})`
      : "missing";
    input.ui.info(`Binary check: ${binaryName} ${status}`);
  }

  return {
    cwd: process.cwd(),
    os: platform.os,
    binaries: REQUIRED_BINARIES.map((name) => platform.binaries[name]),
    dryRun: input.dryRun,
    yes: input.yes,
    log: console,
    ui: input.ui,
    run: runSubprocess,
    manifest: await StateManifest.load(process.cwd()),
  };
}
