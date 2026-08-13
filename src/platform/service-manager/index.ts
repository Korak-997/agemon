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

export interface RegisterAutostartInput {
  unitName: string;
  unitContents: string;
}

export interface RegisterAutostartResult {
  unitPath: string;
  lingerEnabledByAgemon: boolean;
}

export interface UnregisterAutostartInput {
  unitName: string;
  disableLinger: boolean;
}

export interface ServiceManager {
  isActive(unitName: string): Promise<ServiceStatus>;
  registerAutostart(
    input: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult>;
  unregisterAutostart(input: UnregisterAutostartInput): Promise<void>;
}

export interface CreateServiceManagerInput {
  os: "ubuntu";
  run: RunCommand;
  homeDir?: string;
  user?: string;
}

export function createServiceManager(
  input: CreateServiceManagerInput,
): ServiceManager {
  if (process.env.AGEMON_FAKE_SERVICES === "1") {
    return createFakeServiceManager({
      homeDir: input.homeDir,
      user: input.user,
    });
  }

  return createLinuxServiceManager({
    run: input.run,
    homeDir: input.homeDir,
    user: input.user,
  });
}
