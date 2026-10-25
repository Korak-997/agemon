import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHomeDirectory } from "../home.js";
import type {
  RegisterAutostartInput,
  RegisterAutostartResult,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
  UnregisterAutostartResult,
} from "./index.js";
import {
  AGEMON_DAEMON_UNIT_PATTERN,
  workingDirectoryOfUnit,
} from "./unit-files.js";

interface CreateFakeServiceManagerInput {
  homeDir?: string;
  user?: string;
}

interface FakeServiceState {
  unitName: string;
  unitContents: string;
  attemptLabel: string;
  user: string;
  active: boolean;
  lingerEnabledByAgemon: boolean;
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
  const homeDir = input.homeDir ?? resolveHomeDirectory();
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
    const [firstAttempt] = registration.attempts;
    const state: FakeServiceState = {
      unitName: registration.unitName,
      unitContents: firstAttempt.unitContents,
      attemptLabel: firstAttempt.label,
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
      attemptLabel: state.attemptLabel,
      failedAttempts: [],
    };
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<UnregisterAutostartResult> => {
    await rm(markerPath(homeDir, registration.unitName), { force: true });
    if (!registration.disableLinger) {
      return { lingerKeptFor: null };
    }
    const markers = await readdir(
      join(homeDir, ".agemon", "fake-services"),
    ).catch(() => []);
    const lingerKeptFor =
      markers
        .map((marker) => marker.replace(/\.json$/, ""))
        .find((unitName) => AGEMON_DAEMON_UNIT_PATTERN.test(unitName)) ?? null;
    return { lingerKeptFor };
  };

  const readUnitWorkingDirectory = async (
    unitName: string,
  ): Promise<string | null> => {
    const marker = await readMarker(homeDir, unitName);
    return marker === null ? null : workingDirectoryOfUnit(marker.unitContents);
  };

  return {
    isActive,
    registerAutostart,
    unregisterAutostart,
    readUnitWorkingDirectory,
  };
}
