import { detectPlatform, REQUIRED_BINARIES } from "../platform/detect.js";
import type { ServiceManager } from "../platform/service-manager/index.js";
import { createServiceManager } from "../platform/service-manager/index.js";
import type { StepSpinner } from "../ui/spinner.js";
import { createConfirmer } from "./prompt.js";
import { StateManifest } from "./state-manifest.js";
import {
  type RunSubprocessOptions,
  runSubprocess,
  type SubprocessResult,
} from "./subprocess-runner.js";

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
  run: (
    command: string,
    args: string[],
    options?: RunSubprocessOptions,
  ) => Promise<SubprocessResult>;
  manifest: StateManifest;
  serviceManager: ServiceManager;
  /**
   * Asks "are you sure" mid-run. Resolves to `true` immediately when `--yes`
   * is set, `false` immediately when there's no TTY to prompt on, and
   * otherwise shows a real y/N prompt. See core/prompt.ts.
   */
  confirm: (message: string) => Promise<boolean>;
  /**
   * Raw `--skill-groups` CLI value, or undefined when the flag was omitted.
   * Parsed and resolved by the skills plugin itself (see
   * plugins/skills/group-selection.ts) — kept as a raw string here so
   * Context stays a plain passthrough of CLI input, not plugin-specific
   * state.
   */
  skillGroupsOption?: string;
}

export interface CreateContextInput {
  dryRun: boolean;
  yes: boolean;
  ui: StepSpinner;
  skillGroups?: string;
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
    skillGroupsOption: input.skillGroups,
    log: console,
    ui: input.ui,
    run: runSubprocess,
    manifest: await StateManifest.load(process.cwd()),
    serviceManager: createServiceManager({
      os: platform.os,
      run: runSubprocess,
      homeDir: process.env.HOME,
      user: process.env.USER,
    }),
    confirm: createConfirmer({ yes: input.yes }),
  };
}
