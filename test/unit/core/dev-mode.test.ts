import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../../../src/core/context.js";
import {
  assertFakeBackendsAreDevOnly,
  isDevMode,
} from "../../../src/core/dev-mode.js";
import {
  resetFakeSubprocessState,
  takeFakeVerifiedBinaryInstallRequests,
} from "../../../src/core/fake-subprocess.js";
import { AGNIX_VERSION } from "../../../src/plugins/pins.js";
import { SILENT_PROGRESS } from "../../../src/ui/progress.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetFakeSubprocessState();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createTempDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-dev-mode-test-")),
  );
  createdTempDirectories.push(directory);
  return directory;
}

async function createPackagedLayout(): Promise<string> {
  const packageRoot = await createTempDirectory();
  await mkdir(join(packageRoot, "dist"));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "agemon", version: "9.1.0" }),
  );
  return packageRoot;
}

function stubDevModeWithFakeInstaller(): void {
  vi.stubEnv("AGEMON_DEV", "1");
  vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");
}

async function createTestContext() {
  return createContext({
    repoRoot: await createTempDirectory(),
    platform: LINUX_TEST_PLATFORM,
    dryRun: false,
    yes: true,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    progress: SILENT_PROGRESS,
  });
}

describe("dev mode in a packaged layout", () => {
  it("ignores AGEMON_DEV=1", async () => {
    vi.stubEnv("AGEMON_DEV", "1");

    expect(isDevMode(await createPackagedLayout())).toBe(false);
  });

  it("refuses the fake backends even with AGEMON_DEV=1", async () => {
    const packageRoot = await createPackagedLayout();
    stubDevModeWithFakeInstaller();
    vi.stubEnv("AGEMON_FAKE_SERVICES", "1");

    expect(() => assertFakeBackendsAreDevOnly(packageRoot)).toThrow(
      "AGEMON_FAKE_SUBPROCESS, AGEMON_FAKE_SERVICES must never be set outside the sandbox harness",
    );
  });
});

describe("dev mode in the source checkout", () => {
  it("honours AGEMON_DEV=1", () => {
    vi.stubEnv("AGEMON_DEV", "1");

    expect(isDevMode()).toBe(true);
  });
});

describe("createContext and the fake installer", () => {
  it("refuses AGEMON_FAKE_SUBPROCESS=1 without dev mode", async () => {
    vi.stubEnv("AGEMON_DEV", "");
    vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "1");

    await expect(createTestContext()).rejects.toThrow(
      "AGEMON_FAKE_SUBPROCESS must never be set outside the sandbox harness",
    );
  });

  it("picks the fake installer in dev mode", async () => {
    stubDevModeWithFakeInstaller();
    const ctx = await createTestContext();
    const request = {
      packageName: "agnix",
      version: AGNIX_VERSION,
      binaryPathInPackage: "bin/agnix-binary",
      archiveMemberName: "agnix",
      candidates: [{ url: "https://example.test/a", sha256: "0".repeat(64) }],
      packageTarball: {
        url: "https://example.test/agnix.tgz",
        integrity: "sha512-x",
      },
    };

    await ctx.verifiedBinaryInstaller.install(request);

    expect(takeFakeVerifiedBinaryInstallRequests()).toEqual([request]);
  });
});
