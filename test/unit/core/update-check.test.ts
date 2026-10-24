import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));
const prompt = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn(() => true),
  promptYesNo: vi.fn(async () => true),
}));

vi.mock("node:child_process", () => childProcess);
vi.mock("../../../src/core/prompt.js", () => prompt);

const { checkForUpdate } = await import("../../../src/core/update-check.js");

const CURRENT_VERSION = "4.7.2";
const LATEST_VERSION = "4.8.0";
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/Korak-997/agemon/releases/latest";
const RELEASE_ASSET_BASE_URL = `https://github.com/Korak-997/agemon/releases/download/v${LATEST_VERSION}`;
const INSTALLER_SCRIPT = "#!/usr/bin/env sh\necho installing\n";

const createdTempDirectories: string[] = [];
let cacheHome: string;
let releaseAssets: Map<string, string>;

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function checksumLine(contents: string, assetName: string): string {
  return `${sha256(contents)}  ${assetName}`;
}

function serveRelease(options: {
  tagName?: unknown;
  installer?: string;
  checksums?: string;
}): void {
  releaseAssets = new Map([
    [
      LATEST_RELEASE_API_URL,
      JSON.stringify({ tag_name: options.tagName ?? `v${LATEST_VERSION}` }),
    ],
    [
      `${RELEASE_ASSET_BASE_URL}/install.sh`,
      options.installer ?? INSTALLER_SCRIPT,
    ],
    [
      `${RELEASE_ASSET_BASE_URL}/SHA256SUMS`,
      options.checksums ??
        `${checksumLine("tarball", "agemon.tgz")}\n${checksumLine(INSTALLER_SCRIPT, "install.sh")}\n`,
    ],
  ]);
}

function executedScriptPath(): string {
  return childProcess.execFileSync.mock.calls[0][1][0];
}

beforeEach(async () => {
  cacheHome = await mkdtemp(join(tmpdir(), "agemon-update-check-test-"));
  createdTempDirectories.push(cacheHome);
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.stubEnv("AGEMON_DEV", "");
  vi.stubEnv("AGEMON_NO_UPDATE_CHECK", "");
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
  childProcess.execFileSync.mockReset();
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
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
    },
  );
});

describe("checkForUpdate installer verification", () => {
  it("runs the downloaded installer from a temp file when its checksum matches", async () => {
    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("updated");

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = childProcess.execFileSync.mock.calls[0];
    expect(command).toBe("sh");
    expect(args).toHaveLength(1);
    expect(options.env.AGEMON_VERSION).toBe(LATEST_VERSION);
    expect(existsSync(dirname(executedScriptPath()))).toBe(false);
  });

  it.each([
    [
      "the checksum does not match",
      { installer: "#!/usr/bin/env sh\necho tampered\n" },
    ],
    [
      "SHA256SUMS has no install.sh line",
      { checksums: `${checksumLine("tarball", "agemon.tgz")}\n` },
    ],
    [
      "SHA256SUMS lists install.sh twice",
      {
        checksums: `${checksumLine(INSTALLER_SCRIPT, "install.sh")}\n${checksumLine(INSTALLER_SCRIPT, "install.sh")}\n`,
      },
    ],
    [
      "the checksum is upper-case",
      { checksums: `${sha256(INSTALLER_SCRIPT).toUpperCase()}  install.sh\n` },
    ],
    [
      "install.sh exceeds the size limit",
      { installer: "x".repeat(1024 * 1024 + 1) },
    ],
  ])("fails without executing anything when %s", async (_label, release) => {
    serveRelease(release);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("update-failed");
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("rejects an oversized install.sh by its declared length before reading it", async () => {
    const declaredLengthFetch = vi.fn(
      async (url: string) =>
        new Response(releaseAssets.get(url) ?? "", {
          status: 200,
          headers: url.endsWith("/install.sh")
            ? { "content-length": String(1024 * 1024 + 1) }
            : {},
        }),
    );
    vi.stubGlobal("fetch", declaredLengthFetch);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("update-failed");
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("fails without executing anything when the release has no SHA256SUMS", async () => {
    releaseAssets.delete(`${RELEASE_ASSET_BASE_URL}/SHA256SUMS`);

    await expect(
      checkForUpdate({ currentVersion: CURRENT_VERSION, dryRun: false }),
    ).resolves.toBe("update-failed");
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});
