import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { assertFakeBackendsAreDevOnly } from "../core/dev-mode.js";

export const REQUIRED_BINARIES = [
  "python3",
  "pip",
  "pipx",
  "uv",
  "code-review-graph",
] as const;

export type RequiredBinary = (typeof REQUIRED_BINARIES)[number];

export interface BinaryDetectionResult {
  name: RequiredBinary;
  present: boolean;
  path?: string;
}

type PlatformFamily = "linux" | "darwin" | "other";

export type ServiceManagerKind = "systemd-user" | "launchd" | "none";

export interface PlatformCapabilities {
  family: PlatformFamily;
  arch: string;
  serviceManager: ServiceManagerKind;
  unsupportedReason: string | null;
}

export interface DetectPlatformInput {
  osReleasePath?: string;
  hostPlatform?: NodeJS.Platform;
  hostArch?: string;
  systemdRuntimeDirectory?: string;
}

const SUPPORTED_LINUX_IDS = ["ubuntu", "debian"];
const SYSTEMD_RUNTIME_DIRECTORY = "/run/systemd/system";
const READ_ONLY_COMMANDS_NOTE =
  "Read-only commands (inspect, status, plan) still work here.";

export class UnsupportedPlatformError extends Error {}

function normalizeOsReleaseValue(value: string): string {
  const trimmedValue = value.trim();
  if (
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
  ) {
    return trimmedValue.slice(1, -1);
  }
  return trimmedValue;
}

function readOsReleaseField(
  osReleaseContents: string,
  fieldName: string,
): string | undefined {
  for (const line of osReleaseContents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (key === fieldName) {
      return normalizeOsReleaseValue(
        trimmedLine.slice(separatorIndex + 1),
      ).toLowerCase();
    }
  }

  return undefined;
}

function isSupportedLinuxDistribution(osReleaseContents: string): boolean {
  const osId = readOsReleaseField(osReleaseContents, "ID") ?? "";
  const osIdLike = readOsReleaseField(osReleaseContents, "ID_LIKE") ?? "";
  return [osId, ...osIdLike.split(/\s+/)].some((id) =>
    SUPPORTED_LINUX_IDS.includes(id),
  );
}

async function findLinuxUnsupportedReason(
  osReleasePath: string,
): Promise<string | null> {
  let osReleaseContents: string;
  try {
    osReleaseContents = await readFile(osReleasePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return `agemon could not identify this Linux distribution: reading ${osReleasePath} failed (${code}). ${READ_ONLY_COMMANDS_NOTE}`;
  }

  if (isSupportedLinuxDistribution(osReleaseContents)) {
    return null;
  }
  const osId = readOsReleaseField(osReleaseContents, "ID") ?? "unknown";
  return `agemon can only change Ubuntu, Debian, their derivatives and macOS. ${osReleasePath} reports '${osId}'. ${READ_ONLY_COMMANDS_NOTE}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function usesFakeServices(): boolean {
  if (process.env.AGEMON_FAKE_SERVICES !== "1") {
    return false;
  }
  assertFakeBackendsAreDevOnly();
  return true;
}

async function detectLinuxServiceManager(
  systemdRuntimeDirectory: string,
): Promise<ServiceManagerKind> {
  if (usesFakeServices()) {
    return "systemd-user";
  }
  return (await isDirectory(systemdRuntimeDirectory)) ? "systemd-user" : "none";
}

function detectDarwinServiceManager(): ServiceManagerKind {
  return usesFakeServices() ? "systemd-user" : "launchd";
}

function resolveOsReleasePath(input: DetectPlatformInput): string {
  return (
    input.osReleasePath ??
    process.env.AGEMON_OS_RELEASE_PATH ??
    "/etc/os-release"
  );
}

export async function detectPlatformCapabilities(
  input: DetectPlatformInput = {},
): Promise<PlatformCapabilities> {
  const hostPlatform = input.hostPlatform ?? process.platform;
  const arch = input.hostArch ?? process.arch;
  if (hostPlatform === "darwin") {
    return {
      family: "darwin",
      arch,
      serviceManager: detectDarwinServiceManager(),
      unsupportedReason: null,
    };
  }
  if (hostPlatform !== "linux") {
    return {
      family: "other",
      arch,
      serviceManager: "none",
      unsupportedReason: `agemon does not support ${hostPlatform}. ${READ_ONLY_COMMANDS_NOTE}`,
    };
  }

  return {
    family: "linux",
    arch,
    serviceManager: await detectLinuxServiceManager(
      input.systemdRuntimeDirectory ?? SYSTEMD_RUNTIME_DIRECTORY,
    ),
    unsupportedReason: await findLinuxUnsupportedReason(
      resolveOsReleasePath(input),
    ),
  };
}

export function assertPlatformSupportsChanges(
  platform: PlatformCapabilities,
): void {
  if (platform.unsupportedReason !== null) {
    throw new UnsupportedPlatformError(platform.unsupportedReason);
  }
}

export async function findBinaryPath(
  binaryName: string,
  pathEnv: string,
): Promise<string | undefined> {
  for (const pathEntry of pathEnv.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    const binaryPath = join(pathEntry, binaryName);
    try {
      await access(binaryPath, constants.X_OK);
      return binaryPath;
    } catch {}
  }

  return undefined;
}

export async function detectRequiredBinaries(
  pathEnv: string,
): Promise<Record<RequiredBinary, BinaryDetectionResult>> {
  const binaryResults = await Promise.all(
    REQUIRED_BINARIES.map(async (binaryName) => {
      const binaryPath = await findBinaryPath(binaryName, pathEnv);
      return {
        name: binaryName,
        present: binaryPath !== undefined,
        path: binaryPath,
      } satisfies BinaryDetectionResult;
    }),
  );

  return Object.fromEntries(
    binaryResults.map((binaryResult) => [binaryResult.name, binaryResult]),
  ) as Record<RequiredBinary, BinaryDetectionResult>;
}
