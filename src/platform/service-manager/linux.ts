import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../../core/error-message.js";
import {
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "../../core/files.js";
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
  isAgemonDaemonUnitFile,
  workingDirectoryOfUnit,
} from "./unit-files.js";

export interface ServiceClock {
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

interface CreateLinuxServiceManagerInput {
  run: RunCommand;
  homeDir?: string;
  user?: string;
  clock?: ServiceClock;
}

const SYSTEM_COMMAND_TIMEOUT_MS = 20_000;
const UNIT_FILE_MODE = 0o644;
const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_SETTLE_MS = 2_000;

const systemClock: ServiceClock = {
  now: () => Date.now(),
  wait: (milliseconds) => sleep(milliseconds),
};

function resolveUser(user?: string): string {
  const resolvedUser = user ?? process.env.USER;
  if (!resolvedUser) {
    try {
      const fallbackUser = process.env.LOGNAME ?? process.env.USERNAME;
      if (fallbackUser) {
        return fallbackUser;
      }
    } catch {}
    throw new Error(
      "Unable to resolve current user for loginctl commands. Set USER, LOGNAME, or pass an explicit user.",
    );
  }
  return resolvedUser;
}

function resolveUnitPath(homeDir: string, unitName: string): string {
  return join(homeDir, ".config", "systemd", "user", unitName);
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
    throw new Error(result.stderr || failureMessage);
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
  const homeDir = input.homeDir ?? resolveHomeDirectory();
  const user = resolveUser(input.user);
  const clock = input.clock ?? systemClock;

  const isActive = async (unitName: string): Promise<ServiceStatus> => {
    const result = await input.run(
      "systemctl",
      ["--user", "is-active", unitName],
      {
        timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
      },
    );
    return { active: result.code === 0 };
  };

  const readLingerIsOn = async (): Promise<boolean> => {
    const lingerStatus = await assertSucceeded(
      input.run,
      "loginctl",
      ["show-user", user, "--property=Linger", "--value"],
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
  ): Promise<{ activeState: string; restarts: number }> => {
    const show = await assertSucceeded(
      input.run,
      "systemctl",
      [
        "--user",
        "show",
        unitName,
        "--property=ActiveState",
        "--property=NRestarts",
      ],
      `Unable to read the state of ${unitName}.`,
    );
    const properties = parseProperties(show.stdout);
    return {
      activeState: properties.get("ActiveState") ?? "unknown",
      restarts: Number(properties.get("NRestarts") ?? "0") || 0,
    };
  };

  const waitUntilSteadilyActive = async (unitName: string): Promise<void> => {
    const deadline = clock.now() + READINESS_TIMEOUT_MS;
    let activeSince: number | null = null;
    for (;;) {
      const { activeState, restarts } = await readUnitState(unitName);
      if (restarts > 0) {
        throw new Error(
          `${unitName} restarted ${restarts} time(s) after it started`,
        );
      }
      if (activeState === "failed" || activeState === "inactive") {
        throw new Error(`${unitName} is ${activeState}`);
      }
      if (activeState === "active") {
        activeSince ??= clock.now();
        if (clock.now() - activeSince >= READINESS_SETTLE_MS) {
          return;
        }
      } else {
        activeSince = null;
        if (clock.now() >= deadline) {
          throw new Error(
            `${unitName} was still ${activeState} after ${READINESS_TIMEOUT_MS / 1000} s`,
          );
        }
      }
      await clock.wait(READINESS_POLL_INTERVAL_MS);
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
    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "enable", "--now", unitName],
      "Unable to enable/start the daemon unit.",
    );
    await waitUntilSteadilyActive(unitName);
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
        disableResult.stderr ||
          "Unable to disable/stop the daemon unit during uninstall.",
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
    try {
      await rm(unitPath, { force: true });
    } catch {
      manualCleanup.push(`rm '${unitPath}'`);
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
    const unitPath = resolveUnitPath(homeDir, registration.unitName);
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

  const findAgemonDaemonUnit = async (): Promise<string | null> => {
    let unitFiles: string[];
    try {
      unitFiles = await readdir(dirname(resolveUnitPath(homeDir, "unit")));
    } catch {
      return null;
    }
    return unitFiles.find(isAgemonDaemonUnitFile) ?? null;
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    await stopAndDisable(registration.unitName);
    await rm(resolveUnitPath(homeDir, registration.unitName), { force: true });
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
      [enabled ? "enable-linger" : "disable-linger", user],
      `Unable to ${enabled ? "enable" : "disable"} linger for the current user.`,
    );
  };

  const readUnitWorkingDirectory = async (
    unitName: string,
  ): Promise<string | null> => {
    const unitContents = await readRegularFileIfExists(
      resolveUnitPath(homeDir, unitName),
    );
    return unitContents === null ? null : workingDirectoryOfUnit(unitContents);
  };

  return {
    isActive,
    registerAutostart,
    unregisterAutostart,
    readUnitWorkingDirectory,
    unitPathFor: (unitName) => resolveUnitPath(homeDir, unitName),
    isLingerEnabled: readLingerIsOn,
    enableLinger: () => setLinger(true),
    disableLinger: () => setLinger(false),
    findAgemonDaemonUnit,
  };
}
