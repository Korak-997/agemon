import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHomeDirectory } from "../home.js";
import type {
  RegisterAutostartInput,
  RegisterAutostartResult,
  ServiceManager,
  ServiceStatus,
  UnregisterAutostartInput,
} from "./index.js";
import {
  environmentOfUnit,
  isAgemonDaemonUnitFile,
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
}

function resolveUser(user?: string): string {
  return user ?? process.env.USER ?? "unknown-user";
}

function markerPath(homeDir: string, unitName: string): string {
  return join(homeDir, ".agemon", "fake-services", `${unitName}.json`);
}

function lingerMarkerPath(homeDir: string): string {
  return join(homeDir, ".agemon", "fake-linger");
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
    };
    await writeFile(
      destinationPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    return {
      unitPath: destinationPath,
      attemptLabel: state.attemptLabel,
      failedAttempts: [],
    };
  };

  const unregisterAutostart = async (
    registration: UnregisterAutostartInput,
  ): Promise<void> => {
    await rm(markerPath(homeDir, registration.unitName), { force: true });
  };

  const readUnitWorkingDirectory = async (
    unitName: string,
  ): Promise<string | null> => {
    const marker = await readMarker(homeDir, unitName);
    return marker === null ? null : workingDirectoryOfUnit(marker.unitContents);
  };

  const readUnitEnvironment = async (
    unitName: string,
  ): Promise<Record<string, string> | null> => {
    const marker = await readMarker(homeDir, unitName);
    return marker === null ? null : environmentOfUnit(marker.unitContents);
  };

  const findAgemonDaemonUnit = async (): Promise<string | null> => {
    const markers = await readdir(
      join(homeDir, ".agemon", "fake-services"),
    ).catch(() => []);
    return (
      markers
        .map((marker) => marker.replace(/\.json$/, ""))
        .find(isAgemonDaemonUnitFile) ?? null
    );
  };

  return {
    kind: "systemd-user",
    isActive,
    registerAutostart,
    unregisterAutostart,
    readUnitWorkingDirectory,
    readUnitEnvironment,
    unitPathFor: (unitName) => markerPath(homeDir, unitName),
    isLingerEnabled: async () => existsSync(lingerMarkerPath(homeDir)),
    async enableLinger() {
      await mkdir(join(homeDir, ".agemon"), { recursive: true });
      await writeFile(lingerMarkerPath(homeDir), `${user}\n`, "utf8");
    },
    async disableLinger() {
      await rm(lingerMarkerPath(homeDir), { force: true });
    },
    findAgemonDaemonUnit,
  };
}
