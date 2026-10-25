import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { theme } from "../ui/theme.js";
import {
  compareReleaseVersions,
  fetchLatestReleaseVersion,
  parseReleaseVersion,
} from "./github-release.js";
import { assertRootUsesItsOwnEnvironment } from "./install-location.js";
import { type InstallMethod, resolveInstallMethod } from "./install-method.js";
import { isInteractiveTerminal, promptYesNo } from "./prompt.js";
import { installRelease } from "./self-upgrade.js";

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

interface UpdateCheckCache {
  lastCheckedAt: string;
  latestVersion: string;
}

export function resolveAgemonCacheDirectory(): string {
  const configuredCacheHome = process.env.XDG_CACHE_HOME;
  const cacheHome =
    configuredCacheHome && isAbsolute(configuredCacheHome)
      ? configuredCacheHome
      : join(homedir(), ".cache");
  return join(cacheHome, "agemon");
}

function resolveCachePath(): string {
  return join(resolveAgemonCacheDirectory(), "update-check.json");
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

async function resolveLatestVersion(
  signal: AbortSignal,
): Promise<string | undefined> {
  const cachePath = resolveCachePath();
  const cached = readCache(cachePath);
  const cacheAge = cached
    ? Date.now() - Date.parse(cached.lastCheckedAt)
    : Infinity;

  if (cached && cacheAge < UPDATE_CHECK_INTERVAL_MS) {
    return cached.latestVersion;
  }

  try {
    const fetchedVersion = await fetchLatestReleaseVersion(
      AbortSignal.any([signal, AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)]),
    );
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

export interface UpdateCheckInput {
  currentVersion: string;
  dryRun: boolean;
  quiet: boolean;
}

export type UpdateCheckOutcome = "updated" | "update-failed" | "not-updated";

export interface PendingUpdateCheck {
  finish(options: { yes: boolean }): Promise<UpdateCheckOutcome>;
  abort(): void;
}

const CI_DISABLED_VALUES: readonly string[] = ["", "0", "false"];

function isRunningInCi(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && !CI_DISABLED_VALUES.includes(ci.toLowerCase());
}

function isUpdateCheckDisabled(input: UpdateCheckInput): boolean {
  return (
    input.dryRun ||
    input.quiet ||
    isRunningInCi() ||
    process.env.AGEMON_DEV === "1" ||
    process.env.AGEMON_NO_UPDATE_CHECK === "1"
  );
}

function runsWithItsOwnEnvironment(): boolean {
  try {
    assertRootUsesItsOwnEnvironment();
    return true;
  } catch {
    return false;
  }
}

function upgradeHint(
  kind: InstallMethod["kind"],
  latestVersion: string,
): string {
  switch (kind) {
    case "install-script":
      return "Run 'agemon upgrade' to install it.";
    case "npm-global":
      return `Run 'agemon upgrade' (or 'npm install --global agemon@${latestVersion}').`;
    case "npx":
      return "Run 'npx agemon@latest' to use it.";
    default:
      return "Update this copy the way you installed it.";
  }
}

async function offerUpdate(
  latestVersion: string | undefined,
  currentVersion: string,
  options: { yes: boolean },
): Promise<UpdateCheckOutcome> {
  const runningVersion = parseReleaseVersion(currentVersion);
  if (
    !latestVersion ||
    !runningVersion ||
    compareReleaseVersions(latestVersion, runningVersion) <= 0
  ) {
    return "not-updated";
  }

  const updateNotice = `A new version of agemon is available: ${currentVersion} -> ${latestVersion}.`;
  if (!runsWithItsOwnEnvironment()) {
    console.log(
      theme.accent(`${updateNotice} Run 'agemon upgrade' to install it.`),
    );
    return "not-updated";
  }
  const method = await resolveInstallMethod();
  const canInstallHere =
    method.kind === "install-script" || method.kind === "npm-global";

  if (options.yes || !isInteractiveTerminal() || !canInstallHere) {
    console.log(
      theme.accent(
        `${updateNotice} ${upgradeHint(method.kind, latestVersion)}`,
      ),
    );
    return "not-updated";
  }

  const shouldUpdate = await promptYesNo(`${updateNotice} Install it now?`);
  if (!shouldUpdate) {
    return "not-updated";
  }

  console.log(theme.accent("Updating agemon..."));
  try {
    await installRelease(method, latestVersion, latestVersion);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      theme.danger(
        `Automatic update failed (${reason}). Run 'agemon upgrade' to retry.`,
      ),
    );
    return "update-failed";
  }

  console.log(theme.ok(`Updated to ${latestVersion}.`));
  return "updated";
}

export function startUpdateCheck(
  input: UpdateCheckInput,
): PendingUpdateCheck | null {
  if (isUpdateCheckDisabled(input)) {
    return null;
  }

  const controller = new AbortController();
  let lookup: { latestVersion: string | undefined } | null = null;
  resolveLatestVersion(controller.signal).then(
    (latestVersion) => {
      lookup = { latestVersion };
    },
    () => {
      lookup = { latestVersion: undefined };
    },
  );

  return {
    async finish(options) {
      if (lookup === null) {
        controller.abort();
        return "not-updated";
      }
      return offerUpdate(lookup.latestVersion, input.currentVersion, options);
    },
    abort() {
      controller.abort();
    },
  };
}
