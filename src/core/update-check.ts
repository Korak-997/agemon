import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { theme } from "../ui/theme.js";

const GITHUB_REPO = "Korak-997/agemon";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/master/install.sh`;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

interface UpdateCheckCache {
  lastCheckedAt: string;
  latestVersion: string;
}

function resolveCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "agemon", "update-check.json");
}

function readCache(cachePath: string): UpdateCheckCache | undefined {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
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
  const body = (await response.json()) as { tag_name?: string };
  return body.tag_name?.replace(/^v/, "");
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

async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function runInstaller(): boolean {
  try {
    execFileSync("sh", ["-c", `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`], {
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

export interface UpdateCheckInput {
  currentVersion: string;
  dryRun: boolean;
}

/**
 * Checks for a newer agemon release and, if the user opts in, installs it
 * in place via the same installer documented in the README. Returns true
 * when an update was installed — the caller should stop and let the user
 * re-run their command against the new version rather than continue with
 * code that's already been replaced on disk.
 */
export async function checkForUpdate(
  input: UpdateCheckInput,
): Promise<boolean> {
  if (
    input.dryRun ||
    process.env.AGEMON_DEV === "1" ||
    process.env.AGEMON_NO_UPDATE_CHECK === "1"
  ) {
    return false;
  }

  const latestVersion = await resolveLatestVersion().catch(() => undefined);
  if (!latestVersion || !isNewerVersion(latestVersion, input.currentVersion)) {
    return false;
  }

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const updateNotice = `A new version of agemon is available: ${input.currentVersion} -> ${latestVersion}.`;

  if (!isInteractive) {
    console.log(theme.info(`${updateNotice} Run the installer to upgrade.`));
    return false;
  }

  const shouldUpdate = await promptYesNo(`${updateNotice} Install it now?`);
  if (!shouldUpdate) {
    return false;
  }

  console.log(theme.info("Updating agemon..."));
  const updated = runInstaller();
  if (!updated) {
    console.error(
      theme.error(
        `Automatic update failed. Run it yourself: curl -fsSL ${INSTALL_SCRIPT_URL} | sh`,
      ),
    );
    return false;
  }

  console.log(
    theme.success(
      `Updated to ${latestVersion}. Re-run your command to use it.`,
    ),
  );
  return true;
}
