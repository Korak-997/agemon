import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  RegisterAutostartInput,
  RegisterAutostartResult,
  RunCommand,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
} from "./index.js";

interface CreateLinuxServiceManagerInput {
  run: RunCommand;
  homeDir?: string;
  user?: string;
}

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? homedir();
}

function resolveUser(user?: string): string {
  const resolvedUser = user ?? process.env.USER;
  if (!resolvedUser) {
    throw new Error("Unable to resolve current user for loginctl commands.");
  }
  return resolvedUser;
}

function resolveUnitPath(homeDir: string, unitName: string): string {
  return join(homeDir, ".config", "systemd", "user", unitName);
}

async function assertSucceeded(
  run: RunCommand,
  command: string,
  args: string[],
  failureMessage: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || failureMessage);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function createLinuxServiceManager(
  input: CreateLinuxServiceManagerInput,
): ServiceManager {
  const homeDir = resolveHomeDir(input.homeDir);
  const user = resolveUser(input.user);

  const isActive = async (unitName: string): Promise<ServiceStatus> => {
    const result = await input.run("systemctl", [
      "--user",
      "is-active",
      unitName,
    ]);
    return { active: result.code === 0 };
  };

  const registerAutostart = async (
    registration: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult> => {
    const unitPath = resolveUnitPath(homeDir, registration.unitName);
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, registration.unitContents, "utf8");

    const lingerStatus = await assertSucceeded(
      input.run,
      "loginctl",
      ["show-user", user, "--property=Linger", "--value"],
      "Unable to read linger status.",
    );
    const lingerWasOn = lingerStatus.stdout.trim() === "yes";

    if (!lingerWasOn) {
      await assertSucceeded(
        input.run,
        "loginctl",
        ["enable-linger", user],
        "Unable to enable linger for current user.",
      );
    }

    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "daemon-reload"],
      "Unable to reload systemd user units.",
    );

    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "enable", "--now", registration.unitName],
      "Unable to enable/start the daemon unit.",
    );

    return {
      unitPath,
      lingerEnabledByAgemon: !lingerWasOn,
    };
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    await input.run("systemctl", [
      "--user",
      "disable",
      "--now",
      registration.unitName,
    ]);

    const unitPath = resolveUnitPath(homeDir, registration.unitName);
    await rm(unitPath, { force: true });

    await assertSucceeded(
      input.run,
      "systemctl",
      ["--user", "daemon-reload"],
      "Unable to reload systemd user units.",
    );

    if (registration.disableLinger) {
      await assertSucceeded(
        input.run,
        "loginctl",
        ["disable-linger", user],
        "Unable to disable linger for current user.",
      );
    }
  };

  return {
    isActive,
    registerAutostart,
    unregisterAutostart,
  };
}
