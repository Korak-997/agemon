import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RegisterAutostartInput,
  RegisterAutostartResult,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
} from "./index.js";

interface CreateFakeServiceManagerInput {
  homeDir?: string;
  user?: string;
}

interface FakeServiceState {
  unitName: string;
  unitContents: string;
  user: string;
  active: boolean;
  lingerEnabledByAgemon: boolean;
}

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? homedir();
}

function resolveUser(user?: string): string {
  return user ?? process.env.USER ?? "unknown-user";
}

function markerPath(homeDir: string, unitName: string): string {
  return join(homeDir, ".agemon", "fake-services", `${unitName}.json`);
}

async function readMarker(
  homeDir: string,
  unitName: string,
): Promise<FakeServiceState | null> {
  try {
    const markerContents = await readFile(
      markerPath(homeDir, unitName),
      "utf8",
    );
    return JSON.parse(markerContents) as FakeServiceState;
  } catch {
    return null;
  }
}

export function createFakeServiceManager(
  input: CreateFakeServiceManagerInput,
): ServiceManager {
  const homeDir = resolveHomeDir(input.homeDir);
  const user = resolveUser(input.user);

  const isActive = async (unitName: string): Promise<ServiceStatus> => {
    const marker = await readMarker(homeDir, unitName);
    return { active: marker?.active === true };
  };

  const registerAutostart = async (
    registration: RegisterAutostartInput,
  ): Promise<RegisterAutostartResult> => {
    const destinationPath = markerPath(homeDir, registration.unitName);
    await mkdir(join(homeDir, ".agemon", "fake-services"), { recursive: true });
    const state: FakeServiceState = {
      unitName: registration.unitName,
      unitContents: registration.unitContents,
      user,
      active: true,
      lingerEnabledByAgemon: true,
    };
    await writeFile(
      destinationPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    return {
      unitPath: destinationPath,
      lingerEnabledByAgemon: state.lingerEnabledByAgemon,
    };
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    await rm(markerPath(homeDir, registration.unitName), { force: true });
  };

  return {
    isActive,
    registerAutostart,
    unregisterAutostart,
  };
}
