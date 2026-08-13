import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_BINARIES = [
  "python3",
  "pip",
  "pipx",
  "uv",
  "crg",
] as const;

export type RequiredBinary = (typeof REQUIRED_BINARIES)[number];

export interface BinaryDetectionResult {
  name: RequiredBinary;
  present: boolean;
  path?: string;
}

export interface PlatformDetectionResult {
  os: "ubuntu";
  osReleasePath: string;
  binaries: Record<RequiredBinary, BinaryDetectionResult>;
}

export interface DetectPlatformInput {
  osReleasePath?: string;
  pathEnv?: string;
}

export class UnsupportedPlatformError extends Error {
  constructor(osId: string, osReleasePath: string) {
    super(
      `agemon v1 supports Ubuntu only. Detected '${osId}' in ${osReleasePath}. Windows and macOS support are planned for v2.`,
    );
  }
}

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

function parseOsReleaseId(osReleaseContents: string): string {
  const lines = osReleaseContents.split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (key !== "ID") {
      continue;
    }

    return normalizeOsReleaseValue(
      trimmedLine.slice(separatorIndex + 1),
    ).toLowerCase();
  }

  return "unknown";
}

async function findBinaryPath(
  binaryName: RequiredBinary,
  pathEnv: string,
): Promise<string | undefined> {
  for (const pathEntry of pathEnv.split(":")) {
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

async function detectBinaries(
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

function resolveOsReleasePath(input: DetectPlatformInput): string {
  return (
    input.osReleasePath ??
    process.env.AGEMON_OS_RELEASE_PATH ??
    "/etc/os-release"
  );
}

export async function detectPlatform(
  input: DetectPlatformInput = {},
): Promise<PlatformDetectionResult> {
  const osReleasePath = resolveOsReleasePath(input);
  const osReleaseContents = await readFile(osReleasePath, "utf8");
  const osId = parseOsReleaseId(osReleaseContents);

  if (osId !== "ubuntu") {
    throw new UnsupportedPlatformError(osId, osReleasePath);
  }

  return {
    os: "ubuntu",
    osReleasePath,
    binaries: await detectBinaries(input.pathEnv ?? process.env.PATH ?? ""),
  };
}
