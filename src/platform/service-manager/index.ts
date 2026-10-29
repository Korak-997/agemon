import type { ServiceManagerKind } from "../detect.js";
import { resolveHomeDirectory } from "../home.js";
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
  isActive(unitName: string): Promise<ServiceStatus>;
  registerAutostart(
    input: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult>;
  unregisterAutostart(input: UnregisterAutostartInput): Promise<void>;
  readUnitWorkingDirectory(unitName: string): Promise<string | null>;
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

  if (input.kind === "none") {
    return createUnavailableServiceManager(
      createUserUnitFiles(resolveHomeDirectory()),
    );
  }
  return createLinuxServiceManager({
    run: input.run,
    user: input.user,
  });
}
