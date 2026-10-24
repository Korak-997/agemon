import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { theme } from "../ui/theme.js";
import { sha256Hex } from "./fingerprint.js";
import { isInteractiveTerminal, promptYesNo } from "./prompt.js";

const GITHUB_REPO = "Korak-997/agemon";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download`;
const MANUAL_INSTALL_COMMAND = `curl -fsSL https://github.com/${GITHUB_REPO}/releases/latest/download/install.sh | sh`;
const INSTALLER_ASSET_NAME = "install.sh";
const CHECKSUMS_ASSET_NAME = "SHA256SUMS";
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RELEASE_ASSET_BYTES = 1024 * 1024;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3_000;
const INSTALLER_DOWNLOAD_TIMEOUT_MS = 30_000;

interface UpdateCheckCache {
  lastCheckedAt: string;
  latestVersion: string;
}

function resolveCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "agemon", "update-check.json");
}

function parseReleaseVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const version = value.replace(/^v/, "");
  return RELEASE_VERSION_PATTERN.test(version) ? version : undefined;
}

function isUpdateCheckCache(value: unknown): value is UpdateCheckCache {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { lastCheckedAt, latestVersion } = value as Record<string, unknown>;
  return (
    typeof lastCheckedAt === "string" &&
    !Number.isNaN(Date.parse(lastCheckedAt)) &&
    parseReleaseVersion(latestVersion) === latestVersion
  );
}

function readCache(cachePath: string): UpdateCheckCache | undefined {
  try {
    const cache: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    return isUpdateCheckCache(cache) ? cache : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(cachePath: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // Caching is a pure optimization — a failure here must never block the CLI.
  }
}

function parseVersionParts(version: string): [number, number, number] {
  const [core] = version.split("-");
  const [major, minor, patch] = core
    .split(".")
    .map((part) => Number(part) || 0);
  return [major, minor, patch];
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseVersionParts(candidate);
  const currentParts = parseVersionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

async function fetchLatestVersionFromGitHub(): Promise<string | undefined> {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: { "User-Agent": "agemon-update-check" },
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { tag_name?: unknown };
  return parseReleaseVersion(body.tag_name);
}

async function resolveLatestVersion(): Promise<string | undefined> {
  const cachePath = resolveCachePath();
  const cached = readCache(cachePath);
  const cacheAge = cached
    ? Date.now() - Date.parse(cached.lastCheckedAt)
    : Infinity;

  if (cached && cacheAge < UPDATE_CHECK_INTERVAL_MS) {
    return cached.latestVersion;
  }

  try {
    const fetchedVersion = await fetchLatestVersionFromGitHub();
    if (fetchedVersion) {
      writeCache(cachePath, {
        lastCheckedAt: new Date().toISOString(),
        latestVersion: fetchedVersion,
      });
      return fetchedVersion;
    }
  } catch {
    // Offline, rate-limited, or GitHub unreachable — fall through to any
    // stale cached value rather than failing the whole command.
  }

  return cached?.latestVersion;
}

async function downloadReleaseAsset(
  version: string,
  assetName: string,
): Promise<Buffer> {
  const response = await fetch(
    `${RELEASE_DOWNLOAD_BASE_URL}/v${version}/${assetName}`,
    {
      headers: { "User-Agent": "agemon-update-check" },
      signal: AbortSignal.timeout(INSTALLER_DOWNLOAD_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `downloading ${assetName} failed with HTTP ${response.status}`,
    );
  }
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_RELEASE_ASSET_BYTES) {
    throw new Error(`${assetName} is larger than expected`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_RELEASE_ASSET_BYTES) {
    throw new Error(`${assetName} is larger than expected`);
  }
  return body;
}

function readExpectedChecksum(checksums: string, assetName: string): string {
  const assetLines = checksums
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => {
      const listedName = line.split(/\s+/).at(-1);
      return listedName === assetName || listedName === `*${assetName}`;
    });
  const [hash] = assetLines.length === 1 ? assetLines[0].split("  ") : [];
  if (
    !hash ||
    !SHA256_HEX_PATTERN.test(hash) ||
    assetLines[0] !== `${hash}  ${assetName}`
  ) {
    throw new Error(
      `${CHECKSUMS_ASSET_NAME} has no single valid entry for ${assetName}`,
    );
  }
  return hash;
}

async function runVerifiedInstaller(version: string): Promise<void> {
  const [installer, checksums] = await Promise.all([
    downloadReleaseAsset(version, INSTALLER_ASSET_NAME),
    downloadReleaseAsset(version, CHECKSUMS_ASSET_NAME),
  ]);
  const expectedChecksum = readExpectedChecksum(
    checksums.toString("utf8"),
    INSTALLER_ASSET_NAME,
  );

  const scriptDirectory = mkdtempSync(join(tmpdir(), "agemon-update-"));
  try {
    const scriptPath = join(scriptDirectory, INSTALLER_ASSET_NAME);
    writeFileSync(scriptPath, installer, { mode: 0o600 });
    if (sha256Hex(readFileSync(scriptPath)) !== expectedChecksum) {
      throw new Error(
        `${INSTALLER_ASSET_NAME} does not match the release's ${CHECKSUMS_ASSET_NAME}`,
      );
    }
    execFileSync("sh", [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, AGEMON_VERSION: version },
    });
  } finally {
    rmSync(scriptDirectory, { recursive: true, force: true });
  }
}

export interface UpdateCheckInput {
  currentVersion: string;
  dryRun: boolean;
}

export type UpdateCheckOutcome = "updated" | "update-failed" | "not-updated";

export async function checkForUpdate(
  input: UpdateCheckInput,
): Promise<UpdateCheckOutcome> {
  if (
    input.dryRun ||
    process.env.AGEMON_DEV === "1" ||
    process.env.AGEMON_NO_UPDATE_CHECK === "1"
  ) {
    return "not-updated";
  }

  const latestVersion = await resolveLatestVersion().catch(() => undefined);
  if (!latestVersion || !isNewerVersion(latestVersion, input.currentVersion)) {
    return "not-updated";
  }

  const isInteractive = isInteractiveTerminal();
  const updateNotice = `A new version of agemon is available: ${input.currentVersion} -> ${latestVersion}.`;

  if (!isInteractive) {
    console.log(theme.accent(`${updateNotice} Run the installer to upgrade.`));
    return "not-updated";
  }

  const shouldUpdate = await promptYesNo(`${updateNotice} Install it now?`);
  if (!shouldUpdate) {
    return "not-updated";
  }

  console.log(theme.accent("Updating agemon..."));
  try {
    await runVerifiedInstaller(latestVersion);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      theme.danger(
        `Automatic update failed (${reason}). Run it yourself: ${MANUAL_INSTALL_COMMAND}`,
      ),
    );
    return "update-failed";
  }

  console.log(
    theme.ok(`Updated to ${latestVersion}. Re-run your command to use it.`),
  );
  return "updated";
}
