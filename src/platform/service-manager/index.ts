import { createFakeServiceManager } from "./fake.js";
import { createLinuxServiceManager } from "./linux.js";

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
  lingerEnabledByAgemon: boolean;
  attemptLabel: string;
  failedAttempts: string[];
}

export interface UnregisterAutostartInput {
  unitName: string;
  disableLinger: boolean;
}

export interface UnregisterAutostartResult {
  lingerKeptFor: string | null;
}

export interface ServiceManager {
  isActive(unitName: string): Promise<ServiceStatus>;
  registerAutostart(
    input: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult>;
  unregisterAutostart(
    input: UnregisterAutostartInput,
  ): Promise<UnregisterAutostartResult>;
  readUnitWorkingDirectory(unitName: string): Promise<string | null>;
}

export interface CreateServiceManagerInput {
  os: "ubuntu";
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

  return createLinuxServiceManager({
    run: input.run,
    user: input.user,
  });
}
