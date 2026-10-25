import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "./error-message.js";
import { sha256Hex } from "./fingerprint.js";
import type { SubprocessResult } from "./subprocess-runner.js";
import type { RunSubprocess } from "./subprocess-trace.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const NPM_ROOT_TIMEOUT_MS = 20_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 60_000;
const BINARY_PROBE_TIMEOUT_MS = 20_000;
const DOWNLOADED_ARCHIVE_MODE = 0o600;
const EXECUTABLE_MODE = 0o755;

export interface VerifiedArchiveCandidate {
  url: string;
  sha256: string;
}

export interface VerifiedBinaryInstallRequest {
  packageName: string;
  version: string;
  binaryPathInPackage: string;
  archiveMemberName: string;
  candidates: VerifiedArchiveCandidate[];
}

export interface VerifiedBinaryInstaller {
  install(request: VerifiedBinaryInstallRequest): Promise<void>;
}

export interface InstallVerifiedArchiveInput {
  archive: Uint8Array;
  expectedSha256: string;
  archiveMemberName: string;
  extractionParent: string;
  targetPath: string;
  run: RunSubprocess;
}

export type VerifiedArchiveOutcome =
  | { binaryRuns: true }
  | { binaryRuns: false; probeFailure: string };

function describeFailure(result: SubprocessResult, command: string): string {
  return printable(result.stderr.trim()) || `${command} exited ${result.code}`;
}

export async function installVerifiedArchive(
  input: InstallVerifiedArchiveInput,
): Promise<VerifiedArchiveOutcome> {
  const actualSha256 = sha256Hex(Buffer.from(input.archive));
  if (actualSha256 !== input.expectedSha256) {
    throw new Error(
      `Downloaded archive does not match its pinned sha256: expected ${input.expectedSha256}, got ${actualSha256}.`,
    );
  }

  const extractionDirectory = await mkdtemp(
    join(input.extractionParent, ".agemon-extract-"),
  );
  try {
    const archivePath = join(extractionDirectory, "archive.tar.gz");
    await writeFile(archivePath, input.archive, {
      mode: DOWNLOADED_ARCHIVE_MODE,
    });
    const extractResult = await input.run(
      "tar",
      ["-xzf", archivePath, input.archiveMemberName],
      { cwd: extractionDirectory, timeoutMs: EXTRACT_TIMEOUT_MS },
    );
    if (extractResult.code !== 0) {
      throw new Error(
        `Extracting ${input.archiveMemberName} from the verified archive failed: ${describeFailure(extractResult, "tar")}`,
      );
    }

    const extractedBinary = join(extractionDirectory, input.archiveMemberName);
    if (!(await lstat(extractedBinary)).isFile()) {
      throw new Error(
        `${input.archiveMemberName} in the verified archive is not a regular file.`,
      );
    }
    await chmod(extractedBinary, EXECUTABLE_MODE);
    const probeResult = await input.run(extractedBinary, ["--version"], {
      timeoutMs: BINARY_PROBE_TIMEOUT_MS,
    });
    if (probeResult.code !== 0) {
      return {
        binaryRuns: false,
        probeFailure: describeFailure(
          probeResult,
          `${input.archiveMemberName} --version`,
        ),
      };
    }
    await rename(extractedBinary, input.targetPath);
    return { binaryRuns: true };
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readInstalledManifest(
  packageDirectory: string,
): Promise<{ version?: unknown }> {
  try {
    return JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    ) as { version?: unknown };
  } catch (error) {
    throw new Error(
      `${packageDirectory} does not hold an npm-installed package: ${errorMessage(error)}`,
    );
  }
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function resolveGlobalNpmRoot(
  run: RunSubprocess,
  options: { cwd?: string; mayNotExistYet?: boolean } = {},
): Promise<string> {
  const npmRootResult = await run("npm", ["root", "--global"], {
    timeoutMs: NPM_ROOT_TIMEOUT_MS,
    cwd: options.cwd,
  });
  if (npmRootResult.code !== 0) {
    throw new Error(
      `npm root --global failed: ${describeFailure(npmRootResult, "npm")}`,
    );
  }
  const npmRoot = npmRootResult.stdout.trim();
  if (!isAbsolute(npmRoot)) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not an absolute path.`,
    );
  }
  if (resolve(npmRoot) !== npmRoot || !isSafeIdentifier(npmRoot)) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not a single normalised path.`,
    );
  }
  if (options.mayNotExistYet && (await pathIsMissing(npmRoot))) {
    return npmRoot;
  }
  if (!(await isDirectory(npmRoot))) {
    throw new Error(
      `npm root --global returned ${printable(npmRoot)}, which is not a directory. npm masks UUID-like path segments as ***; use an npm prefix without one.`,
    );
  }
  return npmRoot;
}

async function resolveInstalledPackageDirectory(
  run: RunSubprocess,
  request: VerifiedBinaryInstallRequest,
): Promise<string> {
  const npmRoot = await resolveGlobalNpmRoot(run);
  const packageDirectory = join(npmRoot, request.packageName);
  const installedManifest = await readInstalledManifest(packageDirectory);
  if (installedManifest.version !== request.version) {
    throw new Error(
      `${packageDirectory} holds ${request.packageName} ${printable(
        String(installedManifest.version),
      )}, expected ${request.version}.`,
    );
  }
  return packageDirectory;
}

async function readBoundedArchive(
  fetchArchive: typeof fetch,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchArchive(url, {
    signal: AbortSignal.timeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `the archive exceeded the ${MAX_ARCHIVE_BYTES}-byte limit`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadArchive(
  fetchArchive: typeof fetch,
  url: string,
): Promise<Uint8Array> {
  try {
    return await readBoundedArchive(fetchArchive, url);
  } catch (error) {
    throw new Error(`Downloading ${url} failed: ${errorMessage(error)}`);
  }
}

export interface CreateVerifiedBinaryInstallerInput {
  run: RunSubprocess;
  fetch?: typeof fetch;
}

export function createVerifiedBinaryInstaller(
  input: CreateVerifiedBinaryInstallerInput,
): VerifiedBinaryInstaller {
  const fetchArchive = input.fetch ?? fetch;
  return {
    async install(request) {
      const packageDirectory = await resolveInstalledPackageDirectory(
        input.run,
        request,
      );
      const targetPath = join(packageDirectory, request.binaryPathInPackage);

      const probeFailures: string[] = [];
      for (const candidate of request.candidates) {
        const archive = await downloadArchive(fetchArchive, candidate.url);
        const outcome = await installVerifiedArchive({
          archive,
          expectedSha256: candidate.sha256,
          archiveMemberName: request.archiveMemberName,
          extractionParent: packageDirectory,
          targetPath,
          run: input.run,
        });
        if (outcome.binaryRuns) {
          return;
        }
        probeFailures.push(outcome.probeFailure);
      }

      throw new Error(
        `No pinned ${request.packageName} ${request.version} build runs on this host (${probeFailures.join("; ")}).`,
      );
    },
  };
}
