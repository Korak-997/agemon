import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "../../core/error-message.js";
import { RefusedFileError, writeFileAtomic } from "../../core/files.js";
import { currentUid } from "../../core/install-location.js";
import { printable, quoteForShlex } from "../../core/untrusted-text.js";
import { resolveHomeDirectory } from "../home.js";
import type {
  AutostartAttempt,
  RegisterAutostartInput,
  RegisterAutostartResult,
  RunCommand,
  RunCommandResult,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
} from "./index.js";
import {
  createLaunchAgentFiles,
  launchAgentLabelOf,
  readPlistEnvironment,
  readPlistString,
} from "./launch-agent-files.js";
import {
  type ReadinessObservation,
  type ServiceClock,
  systemClock,
  waitUntilSteadilyRunning,
} from "./readiness.js";

interface CreateLaunchdServiceManagerInput {
  run: RunCommand;
  homeDir?: string;
  uid?: number;
  clock?: ServiceClock;
}

const LAUNCHCTL = "/bin/launchctl";
const LAUNCHCTL_TIMEOUT_MS = 20_000;
const PLIST_FILE_MODE = 0o644;
const EXIT_SERVICE_NOT_FOUND = 113;
const EXIT_NO_SUCH_PROCESS = 3;
const BOOTSTRAP_EXIT_CODES_WORTH_RETRYING = [5, 37];
const EXIT_DOMAIN_UNSUPPORTED = 125;
const TEARDOWN_POLL_INTERVAL_MS = 250;
const TEARDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_EXCERPT_LENGTH = 200;
const NO_GUI_SESSION_HINT =
  "log in to this Mac's desktop session and run agemon there";

interface LaunchdJobState {
  state: string | null;
  runs: number;
  lastExitCode: number | null;
}

function excerpt(output: string): string {
  return printable(output.trim()).slice(0, OUTPUT_EXCERPT_LENGTH);
}

function readPrintField(output: string, field: string): string | null {
  return (
    new RegExp(`^\\s*${field} = (.+)$`, "m").exec(output)?.[1].trim() ?? null
  );
}

export function parseLaunchdJobState(printOutput: string): LaunchdJobState {
  const lastExit = readPrintField(printOutput, "last exit code");
  return {
    state: readPrintField(printOutput, "state"),
    runs: Number(readPrintField(printOutput, "runs") ?? "0") || 0,
    lastExitCode:
      lastExit !== null && /^-?\d+$/.test(lastExit) ? Number(lastExit) : null,
  };
}

function observeJob(
  label: string,
  job: LaunchdJobState,
  printOutput: string,
): ReadinessObservation {
  if (job.runs > 1) {
    return {
      kind: "failed",
      reason: `${label} restarted ${job.runs - 1} time(s) after it started`,
    };
  }
  if (job.lastExitCode !== null && job.lastExitCode !== 0) {
    return {
      kind: "failed",
      reason: `${label} exited with code ${job.lastExitCode}`,
    };
  }
  if (job.state === "running") {
    return { kind: "running" };
  }
  if (job.runs >= 1) {
    return {
      kind: "failed",
      reason: `${label} is ${printable(job.state ?? "stopped")}`,
    };
  }
  return {
    kind: "pending",
    state:
      job.state === null
        ? `unrecognised (${excerpt(printOutput)})`
        : printable(job.state),
  };
}

function describeLaunchctlFailure(
  args: string[],
  result: RunCommandResult,
): string {
  const detail = excerpt(result.stderr || result.stdout);
  return `launchctl ${args.join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`;
}

function reportsMissingGuiSession(result: RunCommandResult): boolean {
  return (
    result.code === EXIT_DOMAIN_UNSUPPORTED ||
    /Domain does not support specified action|Could not find domain/i.test(
      result.stderr,
    )
  );
}

function isListedAsDisabled(
  printDisabledOutput: string,
  label: string,
): boolean {
  return printDisabledOutput
    .split("\n")
    .some(
      (line) =>
        line.includes(`"${label}"`) && /=>\s*(?:disabled|true)\b/.test(line),
    );
}

export function createLaunchdServiceManager(
  input: CreateLaunchdServiceManagerInput,
): ServiceManager {
  const files = createLaunchAgentFiles(input.homeDir ?? resolveHomeDirectory());
  const domain = `gui/${input.uid ?? currentUid()}`;
  const clock = input.clock ?? systemClock;

  const launchctl = (args: string[]) =>
    input.run(LAUNCHCTL, args, { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
  const serviceTarget = (label: string) => `${domain}/${label}`;

  const printJob = (label: string) =>
    launchctl(["print", serviceTarget(label)]);

  const isLoaded = async (label: string): Promise<boolean> => {
    const result = await printJob(label);
    if (result.code === EXIT_SERVICE_NOT_FOUND) {
      return false;
    }
    if (result.code !== 0) {
      const failure = describeLaunchctlFailure(
        ["print", serviceTarget(label)],
        result,
      );
      throw new Error(
        reportsMissingGuiSession(result)
          ? `${failure}; ${NO_GUI_SESSION_HINT}`
          : failure,
      );
    }
    return true;
  };

  const bootOutAndWait = async (label: string): Promise<void> => {
    const bootoutResult = await launchctl(["bootout", serviceTarget(label)]);
    const deadline = clock.now() + TEARDOWN_TIMEOUT_MS;
    while (await isLoaded(label)) {
      if (clock.now() >= deadline) {
        const bootoutFailed = ![
          0,
          EXIT_NO_SUCH_PROCESS,
          EXIT_SERVICE_NOT_FOUND,
        ].includes(bootoutResult.code);
        throw new Error(
          `${label} is still loaded ${TEARDOWN_TIMEOUT_MS / 1000} s after launchctl bootout${bootoutFailed ? ` (${describeLaunchctlFailure(["bootout", serviceTarget(label)], bootoutResult)})` : ""}`,
        );
      }
      await clock.wait(TEARDOWN_POLL_INTERVAL_MS);
    }
  };

  const explainBootstrapFailure = async (
    label: string,
    args: string[],
    result: RunCommandResult,
  ): Promise<string> => {
    const failure = describeLaunchctlFailure(args, result);
    const disabled = await launchctl(["print-disabled", domain]);
    if (disabled.code === 0 && isListedAsDisabled(disabled.stdout, label)) {
      return `${failure}; the job is disabled: run 'launchctl enable ${serviceTarget(label)}' or allow it in System Settings › General › Login Items, then run agemon again`;
    }
    return reportsMissingGuiSession(result)
      ? `${failure}; ${NO_GUI_SESSION_HINT}`
      : failure;
  };

  const bootstrap = async (label: string, plistPath: string): Promise<void> => {
    const args = ["bootstrap", domain, plistPath];
    let result = await launchctl(args);
    if (BOOTSTRAP_EXIT_CODES_WORTH_RETRYING.includes(result.code)) {
      await bootOutAndWait(label);
      result = await launchctl(args);
    }
    if (result.code !== 0) {
      throw new Error(await explainBootstrapFailure(label, args, result));
    }
  };

  const observe = async (label: string): Promise<ReadinessObservation> => {
    const result = await printJob(label);
    if (result.code === EXIT_SERVICE_NOT_FOUND) {
      return { kind: "failed", reason: `${label} is not loaded` };
    }
    if (result.code !== 0) {
      return {
        kind: "failed",
        reason: describeLaunchctlFailure(
          ["print", serviceTarget(label)],
          result,
        ),
      };
    }
    return observeJob(
      label,
      parseLaunchdJobState(result.stdout),
      result.stdout,
    );
  };

  const startAttempt = async (
    label: string,
    plistPath: string,
    attempt: AutostartAttempt,
  ): Promise<void> => {
    await writeFileAtomic(plistPath, attempt.unitContents, {
      newFileMode: PLIST_FILE_MODE,
    });
    await chmod(plistPath, PLIST_FILE_MODE);
    if (await isLoaded(label)) {
      await bootOutAndWait(label);
    }
    await bootstrap(label, plistPath);
    await waitUntilSteadilyRunning(label, () => observe(label), clock);
  };

  const removeFailedAgent = async (
    label: string,
    plistPath: string,
  ): Promise<string[]> => {
    const manualCleanup: string[] = [];
    try {
      await bootOutAndWait(label);
    } catch {
      manualCleanup.push(`launchctl bootout ${serviceTarget(label)}`);
    }
    try {
      await rm(plistPath, { force: true });
    } catch {
      manualCleanup.push(`rm ${quoteForShlex(plistPath)}`);
    }
    return manualCleanup;
  };

  const registerAutostart = async (
    registration: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult> => {
    const label = launchAgentLabelOf(registration.unitName);
    const plistPath = files.plistPathFor(registration.unitName);
    await mkdir(dirname(plistPath), { recursive: true });

    const failures: string[] = [];
    const manualCleanup: string[] = [];
    for (const attempt of registration.attempts) {
      try {
        await startAttempt(label, plistPath, attempt);
        return {
          unitPath: plistPath,
          attemptLabel: attempt.label,
          failedAttempts: failures,
        };
      } catch (error) {
        failures.push(`${attempt.label}: ${errorMessage(error)}`);
        if (error instanceof RefusedFileError) {
          break;
        }
        manualCleanup.push(...(await removeFailedAgent(label, plistPath)));
      }
    }

    const cleanupAdvice =
      manualCleanup.length === 0
        ? ""
        : ` Cleanup also failed; run these yourself: ${[...new Set(manualCleanup)].join("; ")}`;
    throw new Error(
      `Could not start ${label} (${failures.join("; ")}).${cleanupAdvice}`,
    );
  };

  const readOwnPlist = async (
    plistFileName: string,
  ): Promise<string | null> => {
    const contents = await files.readPlist(plistFileName);
    if (contents === null) {
      return null;
    }
    const plistPath = files.plistPathFor(plistFileName);
    const label = launchAgentLabelOf(plistFileName);
    if (readPlistString(contents, "Label", plistPath) !== label) {
      throw new RefusedFileError(
        `Refusing to manage ${plistPath}: its Label is not ${label}, so it is not the file agemon wrote.`,
      );
    }
    return contents;
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    const label = launchAgentLabelOf(registration.unitName);
    await readOwnPlist(registration.unitName);
    await bootOutAndWait(label);
    await rm(files.plistPathFor(registration.unitName), { force: true });
  };

  const isActive = async (unitName: string): Promise<ServiceStatus> => {
    const label = launchAgentLabelOf(unitName);
    const result = await printJob(label);
    return {
      active:
        result.code === 0 &&
        parseLaunchdJobState(result.stdout).state === "running",
    };
  };

  const readUnitWorkingDirectory = async (
    unitName: string,
  ): Promise<string | null> => {
    const contents = await readOwnPlist(unitName);
    if (contents === null) {
      return null;
    }
    return readPlistString(
      contents,
      "WorkingDirectory",
      files.plistPathFor(unitName),
    );
  };

  const readUnitEnvironment = async (
    unitName: string,
  ): Promise<Record<string, string> | null> => {
    try {
      const contents = await readOwnPlist(unitName);
      return contents === null ? null : readPlistEnvironment(contents);
    } catch (error) {
      if (error instanceof RefusedFileError) {
        return null;
      }
      throw error;
    }
  };

  const refuseLinger = () =>
    Promise.reject(new Error("launchd has no user linger."));

  return {
    kind: "launchd",
    isActive,
    registerAutostart,
    unregisterAutostart,
    readUnitWorkingDirectory,
    readUnitEnvironment,
    unitPathFor: files.plistPathFor,
    isLingerEnabled: refuseLinger,
    enableLinger: refuseLinger,
    disableLinger: refuseLinger,
    findAgemonDaemonUnit: files.findAgemonLaunchAgent,
  };
}
