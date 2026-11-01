import type { ServiceManagerKind } from "../detect.js";
import { resolveHomeDirectory } from "../home.js";
import { createLaunchdServiceManager } from "./darwin.js";
import { createFakeServiceManager } from "./fake.js";
import { createLinuxServiceManager } from "./linux.js";
import { createUnavailableServiceManager } from "./unavailable.js";
import { createUserUnitFiles } from "./user-unit-files.js";

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
}

export type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<RunCommandResult>;

export interface ServiceStatus {
  active: boolean;
}

export interface AutostartAttempt {
  label: string;
  unitContents: string;
}

export interface RegisterAutostartInput {
  unitName: string;
  attempts: AutostartAttempt[];
}

export interface RegisterAutostartResult {
  unitPath: string;
  attemptLabel: string;
  failedAttempts: string[];
}

export interface UnregisterAutostartInput {
  unitName: string;
}

export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  isActive(unitName: string): Promise<ServiceStatus>;
  registerAutostart(
    input: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult>;
  unregisterAutostart(input: UnregisterAutostartInput): Promise<void>;
  readUnitWorkingDirectory(unitName: string): Promise<string | null>;
  readUnitEnvironment(unitName: string): Promise<Record<string, string> | null>;
  unitPathFor(unitName: string): string;
  isLingerEnabled(): Promise<boolean>;
  enableLinger(): Promise<void>;
  disableLinger(): Promise<void>;
  findAgemonDaemonUnit(): Promise<string | null>;
}

export interface CreateServiceManagerInput {
  kind: ServiceManagerKind;
  run: RunCommand;
  user?: string;
}

export function createServiceManager(
  input: CreateServiceManagerInput,
): ServiceManager {
  if (process.env.AGEMON_FAKE_SERVICES === "1") {
    return createFakeServiceManager({
      user: input.user,
    });
  }

  switch (input.kind) {
    case "systemd-user":
      return createLinuxServiceManager({
        run: input.run,
        user: input.user,
      });
    case "launchd":
      return createLaunchdServiceManager({ run: input.run });
    case "none":
      return createUnavailableServiceManager(
        createUserUnitFiles(resolveHomeDirectory()),
      );
    default: {
      const unhandledKind: never = input.kind;
      throw new Error(`No service manager for ${String(unhandledKind)}`);
    }
  }
}
