import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { theme } from "../ui/theme.js";
import { sha256Hex } from "./fingerprint.js";
import {
  CHECKSUMS_ASSET_NAME,
  compareReleaseVersions,
  downloadReleaseAsset,
  fetchLatestReleaseVersion,
  GITHUB_REPOSITORY,
  parseReleaseVersion,
  RELEASE_WORKFLOW,
  readExpectedChecksum,
  releaseAssetUrl,
} from "./github-release.js";
import {
  assertCurrentUserOwns,
  assertRootUsesItsOwnEnvironment,
  isDefaultInstallDirectory,
  readInstallTreeVersion,
} from "./install-location.js";
import type { InstallMethod } from "./install-method.js";
import { isInteractiveTerminal, promptYesNo } from "./prompt.js";
import {
  agemonSubprocessEnvironment,
  describeSubprocessFailure,
  runSubprocess,
} from "./subprocess-runner.js";
import { printable } from "./untrusted-text.js";

const INSTALLER_ASSET_NAME = "install.sh";
const TARBALL_ASSET_NAME = "agemon.tgz";
const MAX_SCRIPT_ASSET_BYTES = 1024 * 1024;
const MAX_TARBALL_ASSET_BYTES = 20 * 1024 * 1024;
const LATEST_LOOKUP_TIMEOUT_MS = 20_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const ATTESTATION_TIMEOUT_MS = 120_000;
const VERSION_PROBE_TIMEOUT_MS = 20_000;
const PRIVATE_FILE_MODE = 0o600;
const PREVIOUS_INSTALL_SUFFIX = ".prev";

type ReleaseInstallMethod = Extract<
  InstallMethod,
  { kind: "install-script" | "npm-global" }
>;

async function withPrivateTempDirectory<Result>(
  work: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-upgrade-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function downloadVerifiedAsset(
  version: string,
  assetName: string,
  maxBytes: number,
  directory: string,
): Promise<string> {
  const [asset, checksums] = await Promise.all([
    downloadReleaseAsset(version, assetName, maxBytes),
    downloadReleaseAsset(version, CHECKSUMS_ASSET_NAME, MAX_SCRIPT_ASSET_BYTES),
  ]);
  const expectedChecksum = readExpectedChecksum(
    checksums.toString("utf8"),
    assetName,
  );
  const assetPath = join(directory, assetName);
  await writeFile(assetPath, asset, { mode: PRIVATE_FILE_MODE });
  if (sha256Hex(await readFile(assetPath)) !== expectedChecksum) {
    throw new Error(
      `${assetName} does not match the release's ${CHECKSUMS_ASSET_NAME}`,
    );
  }
  return assetPath;
}

async function installThroughScript(
  installDir: string,
  targetVersion: string,
  installerVersion: string,
): Promise<void> {
  const environment: Record<string, string> = {
    ...agemonSubprocessEnvironment(),
    AGEMON_VERSION: targetVersion,
  };
  delete environment.AGEMON_INSTALL_DIR;
  if (!(await isDefaultInstallDirectory(installDir))) {
    environment.AGEMON_INSTALL_DIR = installDir;
  }
  await withPrivateTempDirectory(async (directory) => {
    const scriptPath = await downloadVerifiedAsset(
      installerVersion,
      INSTALLER_ASSET_NAME,
      MAX_SCRIPT_ASSET_BYTES,
      directory,
    );
    await verifyAttestationIfRequested(scriptPath);
    execFileSync("sh", [scriptPath], { stdio: "inherit", env: environment });
  });
}

async function verifyAttestationIfRequested(assetPath: string): Promise<void> {
  if (process.env.AGEMON_VERIFY_ATTESTATION !== "1") {
    return;
  }
  const result = await runSubprocess(
    "gh",
    [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      GITHUB_REPOSITORY,
      "--signer-workflow",
      RELEASE_WORKFLOW,
      "--deny-self-hosted-runners",
    ],
    { timeoutMs: ATTESTATION_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(
      `Build provenance verification failed (gh must be logged in): ${describeSubprocessFailure(result, "gh attestation verify")}`,
    );
  }
}

async function installThroughNpm(
  prefix: string,
  targetVersion: string,
): Promise<void> {
  await withPrivateTempDirectory(async (directory) => {
    const tarballPath = await downloadVerifiedAsset(
      targetVersion,
      TARBALL_ASSET_NAME,
      MAX_TARBALL_ASSET_BYTES,
      directory,
    );
    await verifyAttestationIfRequested(tarballPath);
    const installResult = await runSubprocess(
      "npm",
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        tarballPath,
      ],
      { cwd: directory, timeoutMs: NPM_INSTALL_TIMEOUT_MS },
    );
    if (installResult.code !== 0) {
      throw new Error(
        `npm install failed: ${describeSubprocessFailure(installResult, "npm install")}`,
      );
    }
  });
  const probe = await runSubprocess(
    join(prefix, "bin", "agemon"),
    ["--version"],
    { timeoutMs: VERSION_PROBE_TIMEOUT_MS },
  );
  if (probe.stdout.trim() !== targetVersion) {
    throw new Error(
      `${printable(join(prefix, "bin", "agemon"))} reports '${printable(probe.stdout.trim())}' after the install, expected ${targetVersion}.`,
    );
  }
}

function newerOf(version: string, other: string | undefined): string {
  return other !== undefined && compareReleaseVersions(other, version) > 0
    ? other
    : version;
}

export async function installRelease(
  method: ReleaseInstallMethod,
  targetVersion: string,
  latestVersion: string | undefined,
): Promise<void> {
  assertRootUsesItsOwnEnvironment();
  if (method.kind === "install-script") {
    await assertCurrentUserOwns(method.installDir);
    await installThroughScript(
      method.installDir,
      targetVersion,
      newerOf(targetVersion, latestVersion),
    );
    return;
  }
  await assertCurrentUserOwns(join(method.prefix, "lib", "node_modules"));
  await installThroughNpm(method.prefix, targetVersion);
}

export function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printNpmSteps(prefix: string, version: string): void {
  console.log(
    [
      `cd "$(mktemp -d)"`,
      `curl -fsSLO ${releaseAssetUrl(version, TARBALL_ASSET_NAME)}`,
      `curl -fsSLO ${releaseAssetUrl(version, CHECKSUMS_ASSET_NAME)}`,
      `grep ' ${TARBALL_ASSET_NAME}$' ${CHECKSUMS_ASSET_NAME} | sha256sum -c -   # macOS: shasum -a 256 -c -`,
      `gh attestation verify ${TARBALL_ASSET_NAME} --repo ${GITHUB_REPOSITORY} --signer-workflow ${RELEASE_WORKFLOW} --deny-self-hosted-runners   # optional`,
      `npm install --global --ignore-scripts --prefix ${shellQuoted(printable(prefix))} ./${TARBALL_ASSET_NAME}`,
    ].join("\n"),
  );
}

async function lookUpLatestVersion(): Promise<string | undefined> {
  try {
    return await fetchLatestReleaseVersion(
      AbortSignal.timeout(LATEST_LOOKUP_TIMEOUT_MS),
    );
  } catch {
    return undefined;
  }
}

export async function confirmOrPreview(
  question: string,
  options: { yes: boolean },
): Promise<boolean> {
  if (options.yes) {
    return true;
  }
  if (!isInteractiveTerminal()) {
    console.log(`${question} Re-run with --yes to go ahead.`);
    return false;
  }
  return promptYesNo(question);
}

function refuseOtherMethods(
  method: InstallMethod,
  requestedVersion: string | undefined,
): ReleaseInstallMethod | null {
  switch (method.kind) {
    case "install-script":
    case "npm-global":
      return method;
    case "npx":
      console.log(
        `npx runs the version you ask for; use 'npx agemon@${requestedVersion ?? "latest"}'.`,
      );
      return null;
    case "dev":
      throw new Error("This is a source checkout; update it with git.");
    case "unknown":
      throw new Error(
        `agemon cannot tell how ${printable(method.packageRoot)} was installed. Update it the way you installed it, or reinstall with 'npm install --global agemon' or the install script.`,
      );
  }
}

export interface UpgradeRequest {
  method: InstallMethod;
  runningVersion: string;
  version?: string;
  print: boolean;
  yes: boolean;
}

function parseRequestedVersion(
  version: string | undefined,
): string | undefined {
  if (version === undefined) {
    return undefined;
  }
  const parsed = parseReleaseVersion(version);
  if (parsed === undefined) {
    throw new Error(
      `${printable(version)} is not a release version; use one such as 4.8.0 or v4.8.0-rc.1.`,
    );
  }
  return parsed;
}

export async function runUpgrade(request: UpgradeRequest): Promise<number> {
  const requestedVersion = parseRequestedVersion(request.version);
  const method = refuseOtherMethods(request.method, requestedVersion);
  if (method === null) {
    return 0;
  }
  if (request.print && method.kind !== "npm-global") {
    throw new Error(
      "--print applies only to npm installs; this copy was installed by the install script.",
    );
  }
  const latestVersion = await lookUpLatestVersion();
  const targetVersion = requestedVersion ?? latestVersion;
  if (targetVersion === undefined) {
    throw new Error(
      "Could not look up the latest agemon release on GitHub. Retry later, or name the version: 'agemon upgrade <version>'.",
    );
  }

  const runningVersion = parseReleaseVersion(request.runningVersion);
  if (runningVersion === undefined && requestedVersion === undefined) {
    throw new Error(
      `The running agemon reports ${printable(request.runningVersion)}, which is not a release version; name the version to install: 'agemon upgrade <version>'.`,
    );
  }
  const direction =
    runningVersion === undefined
      ? -1
      : compareReleaseVersions(targetVersion, runningVersion);
  if (direction === 0 || (requestedVersion === undefined && direction < 0)) {
    console.log(
      theme.ok(
        requestedVersion === undefined
          ? `agemon ${request.runningVersion} is up to date (latest release: ${targetVersion}).`
          : `agemon ${request.runningVersion} is already installed.`,
      ),
    );
    return 0;
  }
  if (request.print && method.kind === "npm-global") {
    printNpmSteps(method.prefix, targetVersion);
    return 0;
  }
  if (direction < 0) {
    if (latestVersion === undefined) {
      throw new Error(
        "Could not confirm the newest installer on GitHub, which a downgrade runs. Retry later.",
      );
    }
    const confirmed = await confirmOrPreview(
      `Downgrade agemon ${request.runningVersion} -> ${targetVersion}?`,
      request,
    );
    if (!confirmed) {
      return 0;
    }
  }

  console.log(
    theme.accent(
      `Installing agemon ${targetVersion} (running ${request.runningVersion})...`,
    ),
  );
  await installRelease(method, targetVersion, latestVersion);
  console.log(theme.ok(`agemon ${targetVersion} is installed.`));
  return 0;
}

async function assertPreviousInstallRuns(
  previousDir: string,
  previousVersion: string,
): Promise<void> {
  const probe = await runSubprocess(
    process.execPath,
    [join(previousDir, "bin", "agemon.js"), "--version"],
    { timeoutMs: VERSION_PROBE_TIMEOUT_MS },
  );
  if (probe.stdout.trim() !== previousVersion) {
    throw new Error(
      `${printable(previousDir)} reports '${printable(probe.stdout.trim())}', not the ${printable(previousVersion)} its marker names; it cannot be rolled back to.`,
    );
  }
}

async function swapWithPreviousInstall(
  installDir: string,
  previousDir: string,
): Promise<void> {
  const asideDir = `${installDir}.rollback-${randomUUID().slice(0, 8)}`;
  await rename(installDir, asideDir);
  try {
    await rename(previousDir, installDir);
  } catch (error) {
    try {
      await rename(asideDir, installDir);
    } catch {
      throw new Error(
        `Rollback failed and the current install could not be put back. Move ${printable(asideDir)} back to ${printable(installDir)} by hand.`,
      );
    }
    throw error;
  }
  try {
    await rename(asideDir, previousDir);
  } catch {
    console.error(
      theme.danger(
        `Rolled back, but the replaced install stays at ${printable(asideDir)}; move it to ${printable(previousDir)} to be able to switch back.`,
      ),
    );
  }
}

export async function runRollback(request: {
  method: InstallMethod;
  yes: boolean;
}): Promise<number> {
  if (request.method.kind !== "install-script") {
    throw new Error(
      request.method.kind === "npm-global"
        ? "--rollback is only for install-script installs. With npm, run 'agemon upgrade <previous version>'."
        : "--rollback is only for install-script installs.",
    );
  }
  assertRootUsesItsOwnEnvironment();
  const { installDir } = request.method;
  const previousDir = `${installDir}${PREVIOUS_INSTALL_SUFFIX}`;
  const currentVersion = await readInstallTreeVersion(installDir);
  const previousVersion = await readInstallTreeVersion(previousDir);
  if (previousVersion === null || currentVersion === null) {
    throw new Error(
      `No previous install was kept at ${printable(previousDir)}. Install a specific version with 'agemon upgrade <version>'.`,
    );
  }
  await assertCurrentUserOwns(installDir);
  await assertCurrentUserOwns(previousDir);
  await assertPreviousInstallRuns(previousDir, previousVersion);

  const confirmed = await confirmOrPreview(
    `Switch agemon ${currentVersion} -> ${previousVersion} (the previous install at ${printable(previousDir)})?`,
    request,
  );
  if (!confirmed) {
    return 0;
  }
  await swapWithPreviousInstall(installDir, previousDir);
  console.log(
    theme.ok(
      `Switched to agemon ${previousVersion}. ${currentVersion} is kept as ${printable(previousDir)}; run 'agemon upgrade --rollback' again to switch back.`,
    ),
  );
  return 0;
}
