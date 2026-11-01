import {
  detectRequiredBinaries,
  type PlatformCapabilities,
  REQUIRED_BINARIES,
} from "../platform/detect.js";
import type { ServiceManager } from "../platform/service-manager/index.js";
import { createServiceManager } from "../platform/service-manager/index.js";
import type { StepProgress } from "../ui/progress.js";
import type { StepSpinner } from "../ui/spinner.js";
import type { CustomSkillGroupConfig } from "./config.js";
import {
  type ApprovedOperationSet,
  type ConsentGate,
  type RecordedConflictDecision,
  resolveConsent,
} from "./consent.js";
import { assertFakeBackendsAreDevOnly } from "./dev-mode.js";
import { createGitConfigGuard } from "./git-config-guard.js";
import { createConfirmer, isInteractiveTerminal } from "./prompt.js";
import { clackPrompts } from "./prompt-clack.js";
import { StateManifest } from "./state-manifest.js";
import {
  agemonSubprocessEnvironment,
  type RunSubprocessOptions,
  runSubprocess,
  type SubprocessResult,
} from "./subprocess-runner.js";
import {
  type RunSubprocess,
  traceSubprocessCalls,
} from "./subprocess-trace.js";
import type { GitConfigGuard } from "./untrusted-git-config.js";
import {
  createVerifiedBinaryInstaller,
  type VerifiedBinaryInstaller,
} from "./verified-binary-installer.js";

export type { SubprocessResult } from "./subprocess-runner.js";

export interface BinaryAvailability {
  name: string;
  present: boolean;
  path?: string;
}

export interface Context {
  cwd: string;
  platform: PlatformCapabilities;
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
  verifiedBinaryInstaller: VerifiedBinaryInstaller;

  confirm: (message: string) => Promise<boolean>;
  consent: (
    gates: ConsentGate[],
    options?: {
      conflictDecisions?: ReadonlyMap<string, RecordedConflictDecision>;
    },
  ) => Promise<ApprovedOperationSet>;
  skillGroupsOption?: string;
  customSkillGroups?: CustomSkillGroupConfig[];
  removeSharedTools?: ReadonlySet<string>;
  gitConfigGuard: GitConfigGuard;
}

export interface CreateContextInput {
  repoRoot: string;
  platform: PlatformCapabilities;
  dryRun: boolean;
  yes: boolean;
  ui: StepSpinner;
  progress: StepProgress;
  skillGroups?: string;
  customSkillGroups?: CustomSkillGroupConfig[];
  verbose?: boolean;
  removeSharedTools?: ReadonlySet<string>;
}

async function selectVerifiedBinaryInstaller(
  run: RunSubprocess,
): Promise<VerifiedBinaryInstaller> {
  if (process.env.AGEMON_FAKE_SUBPROCESS === "1") {
    const { createFakeVerifiedBinaryInstaller } = await import(
      "./fake-subprocess.js"
    );
    return createFakeVerifiedBinaryInstaller();
  }
  return createVerifiedBinaryInstaller({ run });
}

export async function createContext(
  input: CreateContextInput,
): Promise<Context> {
  assertFakeBackendsAreDevOnly();
  const binaries = await detectRequiredBinaries(
    agemonSubprocessEnvironment().PATH ?? "",
  );
  const interactive = isInteractiveTerminal();
  const runInRepo: RunSubprocess = (command, args, options) =>
    runSubprocess(command, args, { cwd: input.repoRoot, ...options });
  const run = input.verbose
    ? traceSubprocessCalls(runInRepo, input.ui)
    : runInRepo;

  const checkedBinaries = REQUIRED_BINARIES.map((name) => binaries[name]);
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
    cwd: input.repoRoot,
    platform: input.platform,
    binaries: checkedBinaries,
    dryRun: input.dryRun,
    yes: input.yes,
    interactive,
    skillGroupsOption: input.skillGroups,
    customSkillGroups: input.customSkillGroups,
    removeSharedTools: input.removeSharedTools,
    gitConfigGuard: createGitConfigGuard(input.repoRoot),
    log: console,
    ui: input.ui,
    progress: input.progress,
    run,
    manifest: await StateManifest.load(input.repoRoot),
    serviceManager: createServiceManager({
      kind: input.platform.serviceManager,
      run: runSubprocess,
    }),
    verifiedBinaryInstaller: await selectVerifiedBinaryInstaller(run),
    confirm: createConfirmer({ yes: input.yes }),
    consent: (gates, options) =>
      resolveConsent({
        gates,
        yes: input.yes,
        log: console,
        prompts: clackPrompts,
        conflictDecisions: options?.conflictDecisions,
      }),
  };
}
