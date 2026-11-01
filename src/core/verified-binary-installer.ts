import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findBinaryPath } from "../platform/detect.js";
import { readBoundedBody } from "./bounded-response.js";
import { errorMessage } from "./error-message.js";
import { readRegularFileIfExists, sha256OfRegularFile } from "./files.js";
import { sha256Hex } from "./fingerprint.js";
import { resolveGlobalNpmRoot } from "./npm-global.js";
import { resolveAgemonStateDirectory } from "./state-root.js";
import {
  agemonSubprocessEnvironment,
  describeSubprocessFailure,
} from "./subprocess-runner.js";
import type { RunSubprocess } from "./subprocess-trace.js";
import { printable } from "./untrusted-text.js";

const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 60_000;
const BINARY_PROBE_TIMEOUT_MS = 20_000;
const DOWNLOADED_ARCHIVE_MODE = 0o600;
const EXECUTABLE_MODE = 0o755;
const NPM_INSTALL_TIMEOUT_MS = 180_000;
const MAX_HASHED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NPM_TARBALL_BYTES = 20 * 1024 * 1024;

export interface VerifiedArchiveCandidate {
  url: string;
  sha256: string;
}

export interface PinnedNpmTarball {
  url: string;
  integrity: string;
}

export interface VerifiedBinaryInstallRequest {
  packageName: string;
  version: string;
  binaryPathInPackage: string;
  archiveMemberName: string;
  candidates: VerifiedArchiveCandidate[];
  packageTarball: PinnedNpmTarball;
}

export interface InstalledPackageInspectionRequest {
  packageName: string;
  commandName: string;
  commandPathInPackage: string;
  binaryPathInPackage: string;
  packageFileSha256: Readonly<Record<string, string>>;
  binarySha256: readonly string[];
}

export type InstalledPackageInspection =
  | { kind: "absent" }
  | { kind: "installed"; version: string | null; differences: string[] };

export interface VerifiedBinaryInstaller {
  install(request: VerifiedBinaryInstallRequest): Promise<void>;
  inspect(
    request: InstalledPackageInspectionRequest,
  ): Promise<InstalledPackageInspection>;
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
        `Extracting ${input.archiveMemberName} from the verified archive failed: ${describeSubprocessFailure(extractResult, "tar")}`,
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
        probeFailure: describeSubprocessFailure(
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

async function resolveInstalledPackageDirectory(
  run: RunSubprocess,
  request: VerifiedBinaryInstallRequest,
  cwd: string,
): Promise<string> {
  const npmRoot = await resolveGlobalNpmRoot(run, { cwd });
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
  maxBytes = MAX_ARCHIVE_BYTES,
): Promise<Uint8Array> {
  const response = await fetchArchive(url, {
    signal: AbortSignal.timeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readBoundedBody(
    response.body,
    maxBytes,
    () => new Error(`the archive exceeded the ${maxBytes}-byte limit`),
  );
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

function npmIntegrityOf(contents: Uint8Array): string {
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

async function installVerifiedNpmTarball(
  input: { run: RunSubprocess; fetchArchive: typeof fetch },
  request: VerifiedBinaryInstallRequest,
  directory: string,
): Promise<void> {
  let tarball: Uint8Array;
  try {
    tarball = await readBoundedArchive(
      input.fetchArchive,
      request.packageTarball.url,
      MAX_NPM_TARBALL_BYTES,
    );
  } catch (error) {
    throw new Error(
      `Could not download ${request.packageName} ${request.version} from ${request.packageTarball.url} (${errorMessage(error)}); agemon installs it only from there, verified by its pinned sha512.`,
    );
  }
  if (npmIntegrityOf(tarball) !== request.packageTarball.integrity) {
    throw new Error(
      `The downloaded ${request.packageName} ${request.version} tarball does not match its pinned sha512; nothing was installed.`,
    );
  }
  const tarballPath = join(
    directory,
    `${request.packageName}-${request.version}.tgz`,
  );
  await writeFile(tarballPath, tarball, { mode: DOWNLOADED_ARCHIVE_MODE });
  const installResult = await input.run(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      tarballPath,
    ],
    { cwd: directory, timeoutMs: NPM_INSTALL_TIMEOUT_MS },
  );
  if (installResult.code !== 0) {
    throw new Error(
      `npm global install of the verified ${request.packageName} ${request.version} tarball failed: ${describeSubprocessFailure(installResult, "npm install")}`,
    );
  }
}

async function readOnlyNpmCwd(): Promise<string> {
  try {
    const stateDirectory = (await resolveAgemonStateDirectory("check")).path;
    await lstat(stateDirectory);
    return stateDirectory;
  } catch {
    return homedir();
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstat(path)).isDirectory();
}

async function hashOrReason(path: string): Promise<string> {
  try {
    return await sha256OfRegularFile(path, MAX_HASHED_FILE_BYTES);
  } catch (error) {
    return `unreadable (${errorMessage(error)})`;
  }
}

async function readPackageVersion(
  packageDirectory: string,
): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      (await readRegularFileIfExists(join(packageDirectory, "package.json"))) ??
        "null",
    ) as { version?: unknown } | null;
    return typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function inspectInstalledPackage(
  run: RunSubprocess,
  request: InstalledPackageInspectionRequest,
): Promise<InstalledPackageInspection> {
  let npmRoot: string;
  try {
    npmRoot = await realpath(
      await resolveGlobalNpmRoot(run, { cwd: await readOnlyNpmCwd() }),
    );
  } catch (error) {
    return {
      kind: "installed",
      version: null,
      differences: [
        `could not locate the global npm root (${errorMessage(error)})`,
      ],
    };
  }
  const packageDirectory = join(npmRoot, request.packageName);
  try {
    await lstat(packageDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
  }

  const differences: string[] = [];
  for (const directory of [packageDirectory, join(packageDirectory, "bin")]) {
    if (!(await isRealDirectory(directory).catch(() => false))) {
      differences.push(`${printable(directory)} is not a real directory`);
    }
  }
  for (const [file, expected] of Object.entries(request.packageFileSha256)) {
    const actual = await hashOrReason(join(packageDirectory, file));
    if (actual !== expected) {
      differences.push(
        `${file} ${actual.startsWith("unreadable") ? actual : "differs"}`,
      );
    }
  }
  const binaryHash = await hashOrReason(
    join(packageDirectory, request.binaryPathInPackage),
  );
  if (!request.binarySha256.includes(binaryHash)) {
    differences.push(
      `${request.binaryPathInPackage} ${binaryHash.startsWith("unreadable") ? binaryHash : "is not a pinned build"}`,
    );
  }
  const commandOnPath = await findBinaryPath(
    request.commandName,
    agemonSubprocessEnvironment().PATH ?? "",
  );
  const expectedCommand = join(packageDirectory, request.commandPathInPackage);
  const commandIsThisCopy =
    commandOnPath !== undefined &&
    (await realpath(commandOnPath).catch(() => null)) ===
      (await realpath(expectedCommand).catch(() => expectedCommand));
  if (!commandIsThisCopy) {
    differences.push(
      `${request.commandName} on PATH is not the npm copy at ${printable(packageDirectory)}`,
    );
  }
  return {
    kind: "installed",
    version: await readPackageVersion(packageDirectory),
    differences,
  };
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
    inspect(request) {
      return inspectInstalledPackage(input.run, request);
    },
    async install(request) {
      const downloadDirectory = await mkdtemp(join(tmpdir(), "agemon-npm-"));
      try {
        await installVerifiedNpmTarball(
          { run: input.run, fetchArchive },
          request,
          downloadDirectory,
        );
      } finally {
        await rm(downloadDirectory, { recursive: true, force: true });
      }
      const packageDirectory = await resolveInstalledPackageDirectory(
        input.run,
        request,
        await readOnlyNpmCwd(),
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
