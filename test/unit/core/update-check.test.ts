import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallMethod } from "../../../src/core/install-method.js";

const prompt = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn(() => true),
  promptYesNo: vi.fn(async () => true),
}));
const selfUpgrade = vi.hoisted(() => ({
  installRelease: vi.fn(async () => undefined),
}));
const installMethod = vi.hoisted(() => ({
  resolveInstallMethod: vi.fn(
    async (): Promise<InstallMethod> => ({
      kind: "install-script",
      installDir: "/home/u/.local/share/agemon",
    }),
  ),
}));

vi.mock("../../../src/core/prompt.js", () => prompt);
vi.mock("../../../src/core/self-upgrade.js", () => selfUpgrade);
vi.mock("../../../src/core/install-method.js", () => installMethod);

const { startUpdateCheck } = await import("../../../src/core/update-check.js");

const LOOKUP_SETTLE_MS = 50;

function settleLookup(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LOOKUP_SETTLE_MS));
}

async function checkForUpdate(input: {
  currentVersion: string;
  dryRun: boolean;
}): Promise<string> {
  const pending = startUpdateCheck({ ...input, quiet: false });
  if (pending === null) {
    return "skipped";
  }
  await settleLookup();
  return pending.finish({ yes: false });
}

const CURRENT_VERSION = "4.7.2";
const LATEST_VERSION = "4.8.0";
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/Korak-997/agemon/releases/latest";

const createdTempDirectories: string[] = [];
let cacheHome: string;
let releaseAssets: Map<string, string>;

function serveRelease(options: { tagName?: unknown }): void {
  releaseAssets = new Map([
    [
      LATEST_RELEASE_API_URL,
      JSON.stringify({ tag_name: options.tagName ?? `v${LATEST_VERSION}` }),
    ],
  ]);
}

beforeEach(async () => {
  cacheHome = await mkdtemp(join(tmpdir(), "agemon-update-check-test-"));
  createdTempDirectories.push(cacheHome);
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.stubEnv("AGEMON_DEV", "");
  vi.stubEnv("AGEMON_NO_UPDATE_CHECK", "");
  vi.stubEnv("CI", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  serveRelease({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = releaseAssets.get(url);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  selfUpgrade.installRelease.mockReset();
  installMethod.resolveInstallMethod.mockClear();
  prompt.promptYesNo.mockClear();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function writeCache(contents: string): Promise<void> {
  const cachePath = join(cacheHome, "agemon", "update-check.json");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents, "utf8");
}

describe("checkForUpdate cache validation", () => {
  it.each([
    ["garbage JSON", "{not json"],
    [
      "a non-string version",
      JSON.stringify({
        lastCheckedAt: new Date().toISOString(),
        latestVersion: 9,
      }),
    ],
    [
      "a malformed version",
      JSON.stringify({
        lastCheckedAt: new Date().toISOString(),
        latestVersion: "9.9.9; rm -rf /",
      }),
    ],
    ["a missing timestamp", JSON.stringify({ latestVersion: "9.9.9" })],
    [
      "an unparseable timestamp",
      JSON.stringify({ lastCheckedAt: "yesterday", latestVersion: "9.9.9" }),
    ],
    [
      "a v-prefixed version",
      JSON.stringify({
        lastCheckedAt: new Date().toISOString(),
        latestVersion: "v9.9.9",
      }),
    ],
    ["null", "null"],
  ])(
    "treats a cache with %s as absent and asks GitHub instead",
    async (_label, contents) => {
      await writeCache(contents);
      serveRelease({ tagName: `v${CURRENT_VERSION}` });

      await expect(
        checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
      ).resolves.toBe("not-updated");
      expect(fetch).toHaveBeenCalledWith(
        LATEST_RELEASE_API_URL,
        expect.anything(),
      );
    },
  );
});

describe("checkForUpdate release tag validation", () => {
  it.each([["v9.9.9; rm -rf ~"], ["../../9.9.9"], [42], ["v9.9.9\nx"]])(
    "ignores the malformed tag %j without prompting",
    async (tagName) => {
      serveRelease({ tagName });

      await expect(
        checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
      ).resolves.toBe("not-updated");
      expect(prompt.promptYesNo).not.toHaveBeenCalled();
      expect(selfUpgrade.installRelease).not.toHaveBeenCalled();
    },
  );
});

describe("checkForUpdate offers the update the way this copy was installed", () => {
  const NPM_GLOBAL: InstallMethod = {
    kind: "npm-global",
    packageRoot: "/usr/lib/node_modules/agemon",
    prefix: "/usr",
  };

  it("installs through the shared upgrade path for an install-script copy", async () => {
    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("updated");

    expect(selfUpgrade.installRelease).toHaveBeenCalledWith(
      { kind: "install-script", installDir: "/home/u/.local/share/agemon" },
      LATEST_VERSION,
      LATEST_VERSION,
    );
  });

  it("installs an npm-global copy through npm's own route, never install.sh", async () => {
    installMethod.resolveInstallMethod.mockResolvedValueOnce(NPM_GLOBAL);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("updated");

    expect(selfUpgrade.installRelease).toHaveBeenCalledWith(
      NPM_GLOBAL,
      LATEST_VERSION,
      LATEST_VERSION,
    );
  });

  it("reports a failed install and points at agemon upgrade", async () => {
    selfUpgrade.installRelease.mockRejectedValueOnce(
      new Error("install.sh does not match the release's SHA256SUMS"),
    );

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("update-failed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Run 'agemon upgrade' to retry."),
    );
  });

  it.each([
    [{ kind: "npx" } as InstallMethod, "Run 'npx agemon@latest' to use it."],
    [
      { kind: "dev" } as InstallMethod,
      "Update this copy the way you installed it.",
    ],
    [
      {
        kind: "unknown",
        packageRoot: "/x/node_modules/agemon",
      } as InstallMethod,
      "Update this copy the way you installed it.",
    ],
  ])("only prints a hint for a %o copy", async (method, hint) => {
    installMethod.resolveInstallMethod.mockResolvedValueOnce(method);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("not-updated");

    expect(prompt.promptYesNo).not.toHaveBeenCalled();
    expect(selfUpgrade.installRelease).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(hint));
  });

  it("only prints the notice when root runs with another user's HOME", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("not-updated");

    expect(installMethod.resolveInstallMethod).not.toHaveBeenCalled();
    expect(prompt.promptYesNo).not.toHaveBeenCalled();
  });

  it("never offers an update to a copy whose own version is not a release version", async () => {
    await expect(
      checkForUpdate({ currentVersion: "0.0.0-local", dryRun: false }),
    ).resolves.toBe("not-updated");
    expect(prompt.promptYesNo).not.toHaveBeenCalled();
  });

  it("offers the final release to someone on its release candidate", async () => {
    serveRelease({ tagName: "v4.8.0" });

    await expect(
      checkForUpdate({ currentVersion: "4.8.0-rc.1", dryRun: false }),
    ).resolves.toBe("updated");
  });

  it("never offers an older stable release to someone on a newer candidate", async () => {
    serveRelease({ tagName: "v4.7.2" });

    await expect(
      checkForUpdate({ currentVersion: "4.8.0-rc.1", dryRun: false }),
    ).resolves.toBe("not-updated");
    expect(installMethod.resolveInstallMethod).not.toHaveBeenCalled();
  });
});

describe("startUpdateCheck lifecycle", () => {
  const input = {
    currentVersion: CURRENT_VERSION,
    dryRun: false,
    quiet: false,
  };

  it.each([
    ["--dry-run", { dryRun: true }, {}],
    ["--quiet", { quiet: true }, {}],
    ["CI=1", {}, { CI: "1" }],
    ["CI=true", {}, { CI: "true" }],
  ])("skips the check entirely under %s", (_label, overrides, env) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }

    expect(startUpdateCheck({ ...input, ...overrides })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still checks when CI is explicitly false", () => {
    vi.stubEnv("CI", "false");

    expect(startUpdateCheck(input)).not.toBeNull();
  });

  it("starts the lookup at once and prints the notice only when finished", async () => {
    const pending = startUpdateCheck(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    await settleLookup();

    await expect(pending?.finish({ yes: true })).resolves.toBe("not-updated");

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `A new version of agemon is available: ${CURRENT_VERSION} -> ${LATEST_VERSION}. Run 'agemon upgrade' to install it.`,
      ),
    );
    expect(prompt.promptYesNo).not.toHaveBeenCalled();
    expect(selfUpgrade.installRelease).not.toHaveBeenCalled();
  });

  it("aborts a lookup that has not finished and returns at once", async () => {
    let lookupSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            lookupSignal = init.signal;
            init.signal.addEventListener("abort", () =>
              reject(init.signal.reason),
            );
          }),
      ),
    );
    const pending = startUpdateCheck(input);

    await expect(pending?.finish({ yes: false })).resolves.toBe("not-updated");

    expect(lookupSignal?.aborted).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("aborts the lookup when the command ends without finishing it", () => {
    let lookupSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { signal: AbortSignal }) => {
        lookupSignal = init.signal;
        return new Promise(() => {});
      }),
    );

    startUpdateCheck(input)?.abort();

    expect(lookupSignal?.aborted).toBe(true);
  });
});
