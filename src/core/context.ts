import { detectPlatform, REQUIRED_BINARIES } from "../platform/detect.js";
import type { ServiceManager } from "../platform/service-manager/index.js";
import { createServiceManager } from "../platform/service-manager/index.js";
import type { StepProgress } from "../ui/progress.js";
import type { StepSpinner } from "../ui/spinner.js";
import {
  type ApprovedOperationSet,
  type ConsentGate,
  readlinePrompts,
  resolveConsent,
} from "./consent.js";
import { createConfirmer, isInteractiveTerminal } from "./prompt.js";
import { clackPrompts } from "./prompt-clack.js";
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
  interactive: boolean;
  log: Pick<Console, "log" | "error">;
  ui: StepSpinner;
  progress?: StepProgress;
  run: (
    command: string,
    args: string[],
    options?: RunSubprocessOptions,
  ) => Promise<SubprocessResult>;
  manifest: StateManifest;
  serviceManager: ServiceManager;

  confirm: (message: string) => Promise<boolean>;
  consent: (
    gates: ConsentGate[],
    options?: { conflictDecisions?: Record<string, "keep-mine" | "skip"> },
  ) => Promise<ApprovedOperationSet>;
  skillGroupsOption?: string;
}

export interface CreateContextInput {
  dryRun: boolean;
  yes: boolean;
  ui: StepSpinner;
  progress: StepProgress;
  skillGroups?: string;
}

export async function createContext(
  input: CreateContextInput,
): Promise<Context> {
  const platform = await detectPlatform({
    osReleasePath: process.env.AGEMON_OS_RELEASE_PATH,
  });
  const interactive = isInteractiveTerminal();

  const checkedBinaries = REQUIRED_BINARIES.map(
    (name) => platform.binaries[name],
  );
  const presentBinaries = checkedBinaries.filter((binary) => binary.present);
  const presentNames = presentBinaries.map((binary) => binary.name).join(", ");
  input.ui.info(
    presentNames
      ? `${presentBinaries.length}/${checkedBinaries.length} tools present — ${presentNames}`
      : `${presentBinaries.length}/${checkedBinaries.length} tools present`,
  );
  for (const binary of checkedBinaries) {
    if (!binary.present) {
      input.ui.info(`${binary.name} missing`);
    }
  }

  return {
    cwd: process.cwd(),
    os: platform.os,
    binaries: checkedBinaries,
    dryRun: input.dryRun,
    yes: input.yes,
    interactive,
    skillGroupsOption: input.skillGroups,
    log: console,
    ui: input.ui,
    progress: input.progress,
    run: runSubprocess,
    manifest: await StateManifest.load(process.cwd()),
    serviceManager: createServiceManager({
      os: platform.os,
      run: runSubprocess,
      homeDir: process.env.HOME,
      user: process.env.USER,
    }),
    confirm: createConfirmer({ yes: input.yes }),
    consent: (gates, options) =>
      resolveConsent({
        gates,
        yes: input.yes,
        log: console,
        prompts: interactive ? clackPrompts : readlinePrompts,
        conflictDecisions: options?.conflictDecisions,
      }),
  };
}
