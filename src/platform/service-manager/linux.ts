import { mkdir, readFile, readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../../core/error-message.js";
import { RefusedFileError, writeFileAtomic } from "../../core/files.js";
import { currentUid } from "../../core/install-location.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";
import { quoteForShlex } from "../../core/untrusted-text.js";
import { resolveHomeDirectory } from "../home.js";
import type {
  AutostartAttempt,
  RegisterAutostartInput,
  RegisterAutostartResult,
  RunCommand,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
} from "./index.js";
import {
  type ReadinessObservation,
  type ServiceClock,
  systemClock,
  waitUntilSteadilyRunning,
} from "./readiness.js";
import { createUserUnitFiles } from "./user-unit-files.js";

interface CreateLinuxServiceManagerInput {
  run: RunCommand;
  homeDir?: string;
  user?: string;
  clock?: ServiceClock;
  procRoot?: string;
}

const SYSTEM_COMMAND_TIMEOUT_MS = 20_000;
const UNIT_FILE_MODE = 0o644;
const UNKNOWN_UID = -1;
const PROCESS_ID = /^[1-9]\d*$/;
const PARENT_PID_LINE = /^PPid:\s*([1-9]\d*)$/m;

function resolveUser(user?: string): string {
  if (user !== undefined) {
    return user;
  }
  const uid = currentUid();
  if (uid === UNKNOWN_UID) {
    throw new Error("cannot determine the current user id");
  }
  return String(uid);
}

function reportsUnitNotLoaded(stderr: string, unitName: string): boolean {
  const notLoaded = `Unit ${unitName} not loaded.`;
  const message = stderr.trim();
  return message === notLoaded || message.endsWith(`: ${notLoaded}`);
}

function isMissingUnitError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not loaded") ||
    normalized.includes("does not exist") ||
    normalized.includes("no such file") ||
    normalized.includes("not found")
  );
}

async function assertSucceeded(
  run: RunCommand,
  command: string,
  args: string[],
  failureMessage: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await run(command, args, {
    timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim()
        ? describeSubprocessFailure(result, command)
        : failureMessage,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function parseProperties(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      properties.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return properties;
}

export function createLinuxServiceManager(
  input: CreateLinuxServiceManagerInput,
): ServiceManager {
  const unitFiles = createUserUnitFiles(
    input.homeDir ?? resolveHomeDirectory(),
  );
  const lingerUser = (): string => resolveUser(input.user);
  const clock = input.clock ?? systemClock;
  const procRoot = input.procRoot ?? "/proc";

  const isActive = async (unitName: string): Promise<ServiceStatus> => {
    const result = await input.run(
      "systemctl",
      ["--user", "is-active", unitName],
      {
        timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
      },
    );
    return {
      active: result.code === 0,
      failed: result.stdout.trim() === "failed",
    };
  };

  const readMountNamespace = (pid: string): Promise<string> =>
    readlink(join(procRoot, pid, "ns", "mnt"));

  const readParentPid = async (pid: string): Promise<string> => {
    const status = await readFile(join(procRoot, pid, "status"), "utf8");
    const parentPid = PARENT_PID_LINE.exec(status)?.[1];
    if (parentPid === undefined) {
      throw new Error(`no parent process id in ${pid}'s status`);
    }
    return parentPid;
  };

  // The unit's parent is the systemd user manager. Comparing with it rather than with
  // agemon keeps the answer right when agemon itself runs in another mount namespace
  // (a toolbox container or an agent sandbox).
  const isSandboxEnforced = async (unitName: string): Promise<boolean> => {
    const mainPid = await input.run(
      "systemctl",
      ["--user", "show", "-p", "MainPID", "--value", unitName],
      { timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS },
    );
    const pid = mainPid.stdout.trim();
    if (mainPid.code !== 0 || !PROCESS_ID.test(pid)) {
      return false;
    }
    try {
      const [unitNamespace, userManagerNamespace] = await Promise.all([
        readMountNamespace(pid),
        readParentPid(pid).then(readMountNamespace),
      ]);
      return unitNamespace !== userManagerNamespace;
    } catch {
      return false;
    }
  };

  const readLingerIsOn = async (): Promise<boolean> => {
    const lingerStatus = await assertSucceeded(
      input.run,
      "loginctl",
      ["show-user", lingerUser(), "--property=Linger", "--value"],
      "Unable to read linger status.",
    );
    const linger = lingerStatus.stdout.trim();
    if (linger !== "yes" && linger !== "no") {
      throw new Error(
        `loginctl reported linger as '${linger}' instead of yes or no; nothing was changed.`,
      );
    }
    return linger === "yes";
  };

  const readUnitState = async (
    unitName: string,
  ): Promise<{ activeState: string; subState: string; restarts: number }> => {
    const show = await assertSucceeded(
      input.run,
      "systemctl",
      [
        "--user",
        "show",
        unitName,
        "--property=ActiveState",
        "--property=SubState",
        "--property=NRestarts",
      ],
      `Unable to read the state of ${unitName}.`,
    );
    const properties = parseProperties(show.stdout);
    return {
      activeState: properties.get("ActiveState") ?? "unknown",
      subState: properties.get("SubState") ?? "unknown",
      restarts: Number(properties.get("NRestarts") ?? "0") || 0,
    };
  };

  const observeUnit = async (
    unitName: string,
  ): Promise<ReadinessObservation> => {
    const { activeState, subState, restarts } = await readUnitState(unitName);
    if (restarts > 0) {
      return {
        kind: "failed",
        reason: `${unitName} restarted ${restarts} time(s) after it started`,
      };
    }
    if (subState === "auto-restart") {
      return {
        kind: "failed",
        reason: `${unitName} exited and is waiting to restart`,
      };
    }
    if (activeState === "failed" || activeState === "inactive") {
      return { kind: "failed", reason: `${unitName} is ${activeState}` };
    }
    return activeState === "active"
      ? { kind: "running" }
      : { kind: "pending", state: activeState };
  };

  const runResetFailed = (unitName: string) =>
    input.run("systemctl", ["--user", "reset-failed", unitName], {
      timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
    });

  const resetStartLimit = async (unitName: string): Promise<void> => {
    const result = await runResetFailed(unitName);
    if (result.code !== 0 && !reportsUnitNotLoaded(result.stderr, unitName)) {
      throw new Error(
        result.stderr.trim()
          ? describeSubprocessFailure(result, "systemctl")
          : `Unable to reset the start limit of ${unitName}.`,
      );
    }
  };

  const startAttempt = async (
    unitName: string,
    unitPath: string,
    attempt: AutostartAttempt,
  ): Promise<void> => {
    await writeFileAtomic(unitPath, attempt.unitContents, {
      newFileMode: UNIT_FILE_MODE,
    });
    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "daemon-reload"],
      "Unable to reload systemd user units.",
    );
    await resetStartLimit(unitName);
    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "enable", unitName],
      "Unable to enable the daemon unit.",
    );
    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "restart", unitName],
      "Unable to start the daemon unit.",
    );
    await waitUntilSteadilyRunning(
      unitName,
      () => observeUnit(unitName),
      clock,
    );
  };

  const stopAndDisable = async (unitName: string): Promise<void> => {
    const disableResult = await input.run(
      "systemctl",
      ["--user", "disable", "--now", unitName],
      {
        timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
      },
    );
    if (
      disableResult.code !== 0 &&
      !isMissingUnitError(disableResult.stderr || "")
    ) {
      throw new Error(
        disableResult.stderr.trim()
          ? describeSubprocessFailure(disableResult, "systemctl")
          : "Unable to disable/stop the daemon unit during uninstall.",
      );
    }
  };

  const removeFailedUnit = async (
    unitName: string,
    unitPath: string,
  ): Promise<string[]> => {
    const manualCleanup: string[] = [];
    try {
      await stopAndDisable(unitName);
    } catch {
      manualCleanup.push(`systemctl --user disable --now ${unitName}`);
    }
    await runResetFailed(unitName).catch(() => undefined);
    try {
      await rm(unitPath, { force: true });
    } catch {
      manualCleanup.push(`rm ${quoteForShlex(unitPath)}`);
    }
    try {
      await assertSucceeded(
        input.run,
        "systemctl",
        ["--user", "daemon-reload"],
        "Unable to reload systemd user units.",
      );
    } catch {
      manualCleanup.push("systemctl --user daemon-reload");
    }
    return manualCleanup;
  };

  const registerAutostart = async (
    registration: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult> => {
    const unitPath = unitFiles.unitPathFor(registration.unitName);
    await mkdir(dirname(unitPath), { recursive: true });

    const failures: string[] = [];
    const manualCleanup: string[] = [];
    for (const attempt of registration.attempts) {
      try {
        await startAttempt(registration.unitName, unitPath, attempt);
        return {
          unitPath,
          attemptLabel: attempt.label,
          failedAttempts: failures,
        };
      } catch (error) {
        failures.push(`${attempt.label}: ${errorMessage(error)}`);
        if (error instanceof RefusedFileError) {
          break;
        }
        manualCleanup.push(
          ...(await removeFailedUnit(registration.unitName, unitPath)),
        );
      }
    }

    const cleanupAdvice =
      manualCleanup.length === 0
        ? ""
        : ` Cleanup also failed; run these yourself: ${[...new Set(manualCleanup)].join("; ")}`;
    throw new Error(
      `Could not start ${registration.unitName} (${failures.join("; ")}).${cleanupAdvice}`,
    );
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    await stopAndDisable(registration.unitName);
    await rm(unitFiles.unitPathFor(registration.unitName), { force: true });
    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "daemon-reload"],
      "Unable to reload systemd user units.",
    );
  };

  const setLinger = async (enabled: boolean): Promise<void> => {
    await assertSucceeded(
      input.run,
      "loginctl",
      [enabled ? "enable-linger" : "disable-linger", lingerUser()],
      `Unable to ${enabled ? "enable" : "disable"} linger for the current user.`,
    );
  };

  return {
    kind: "systemd-user",
    isActive,
    isSandboxEnforced,
    registerAutostart,
    unregisterAutostart,
    readUnitWorkingDirectory: unitFiles.readUnitWorkingDirectory,
    readUnitEnvironment: unitFiles.readUnitEnvironment,
    unitPathFor: unitFiles.unitPathFor,
    isLingerEnabled: readLingerIsOn,
    enableLinger: () => setLinger(true),
    disableLinger: () => setLinger(false),
    findAgemonDaemonUnit: unitFiles.findAgemonDaemonUnit,
  };
}
