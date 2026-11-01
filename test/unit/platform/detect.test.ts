import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_READ_FILE_BYTES } from "../../../src/core/files.js";
import { agemonSubprocessEnvironment } from "../../../src/core/subprocess-runner.js";
import {
  assertPlatformSupportsChanges,
  detectPlatformCapabilities,
  detectRequiredBinaries,
  UnsupportedPlatformError,
} from "../../../src/platform/detect.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createTempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agemon-detect-test-"));
  createdTempDirectories.push(root);
  return root;
}

async function detectLinuxWith(osReleaseContents: string) {
  const root = await createTempDirectory();
  const osReleasePath = join(root, "os-release");
  await writeFile(osReleasePath, osReleaseContents);
  return detectPlatformCapabilities({
    osReleasePath,
    hostPlatform: "linux",
    systemdRuntimeDirectory: join(root, "no-systemd"),
  });
}

describe("detectPlatformCapabilities", () => {
  it("supports Ubuntu", async () => {
    const platform = await detectLinuxWith("ID=ubuntu\n");

    expect(platform.family).toBe("linux");
    expect(platform.unsupportedReason).toBeNull();
  });

  it("supports Linux Mint through ID_LIKE", async () => {
    const platform = await detectLinuxWith(
      'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
    );

    expect(platform.unsupportedReason).toBeNull();
  });

  it("supports Pop!_OS through ID_LIKE", async () => {
    const platform = await detectLinuxWith('ID=pop\nID_LIKE="ubuntu debian"\n');

    expect(platform.unsupportedReason).toBeNull();
  });

  it("supports Debian", async () => {
    const platform = await detectLinuxWith('ID=debian\nVERSION_ID="12"\n');

    expect(platform.unsupportedReason).toBeNull();
  });

  it("refuses Fedora with a message naming it", async () => {
    const platform = await detectLinuxWith(
      'ID=fedora\nVERSION_ID=41\nPLATFORM_ID="platform:f41"\n',
    );

    expect(platform.family).toBe("linux");
    expect(platform.unsupportedReason).toContain("reports 'fedora'");
    expect(platform.unsupportedReason).toContain(
      "Read-only commands (inspect, status, plan) still work here.",
    );
  });

  it("ignores VERSION_ID before ID", async () => {
    const platform = await detectLinuxWith("VERSION_ID=ubuntu\nID=fedora\n");

    expect(platform.unsupportedReason).toContain("reports 'fedora'");
  });

  it("does not match a substring in ID_LIKE", async () => {
    const platform = await detectLinuxWith(
      'ID=custom\nID_LIKE="notdebian ubuntulike"\n',
    );

    expect(platform.unsupportedReason).toContain("reports 'custom'");
  });

  it("reports a missing os-release as unsupported instead of throwing ENOENT", async () => {
    const root = await createTempDirectory();
    const osReleasePath = join(root, "missing-os-release");

    const platform = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
    });

    expect(platform.unsupportedReason).toBe(
      `agemon could not identify this Linux distribution: reading ${osReleasePath} failed (ENOENT). Read-only commands (inspect, status, plan) still work here.`,
    );
  });

  it("refuses a FIFO os-release without blocking", async () => {
    const root = await createTempDirectory();
    const osReleasePath = join(root, "os-release");
    execFileSync("mkfifo", [osReleasePath]);

    const platform = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
    });

    expect(platform.unsupportedReason).toMatch(
      /could not identify this Linux distribution: .*not a regular file/,
    );
  });

  it("refuses a character device os-release", async () => {
    const platform = await detectPlatformCapabilities({
      osReleasePath: "/dev/zero",
      hostPlatform: "linux",
    });

    expect(platform.unsupportedReason).toMatch(
      /could not identify this Linux distribution: .*not a regular file/,
    );
  });

  it("treats an os-release over the read cap as unidentified", async () => {
    const root = await createTempDirectory();
    const osReleasePath = join(root, "os-release");
    await writeFile(
      osReleasePath,
      `ID=ubuntu\n${"#".repeat(MAX_READ_FILE_BYTES)}\n`,
    );

    const platform = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
    });

    expect(platform.unsupportedReason).toMatch(
      /could not identify this Linux distribution: .*larger than/,
    );
  });

  it("reads a symlinked os-release, as distributions ship it", async () => {
    const root = await createTempDirectory();
    await writeFile(join(root, "real-os-release"), "ID=debian\n");
    const osReleasePath = join(root, "os-release");
    await symlink(join(root, "real-os-release"), osReleasePath);

    const platform = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
      systemdRuntimeDirectory: join(root, "no-systemd"),
    });

    expect(platform.unsupportedReason).toBeNull();
  });

  it("ignores AGEMON_OS_RELEASE_PATH outside dev mode", async () => {
    const root = await createTempDirectory();
    const fakeOsRelease = join(root, "os-release");
    await writeFile(fakeOsRelease, "ID=fedora\n");
    vi.stubEnv("AGEMON_DEV", "");
    vi.stubEnv("AGEMON_OS_RELEASE_PATH", fakeOsRelease);

    const platform = await detectPlatformCapabilities({
      hostPlatform: "linux",
    });

    expect(platform.unsupportedReason ?? "").not.toContain(fakeOsRelease);

    vi.stubEnv("AGEMON_DEV", "1");
    const devPlatform = await detectPlatformCapabilities({
      hostPlatform: "linux",
    });
    expect(devPlatform.unsupportedReason).toContain(fakeOsRelease);
  });

  it("treats darwin as a supported family with launchd", async () => {
    const platform = await detectPlatformCapabilities({
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    expect(platform).toEqual({
      family: "darwin",
      arch: "arm64",
      serviceManager: "launchd",
      unsupportedReason: null,
    });
  });

  it("reports the host architecture", async () => {
    expect((await detectPlatformCapabilities()).arch).toBe(process.arch);
    expect(
      (
        await detectPlatformCapabilities({
          hostPlatform: "win32",
          hostArch: "x64",
        })
      ).arch,
    ).toBe("x64");
  });

  it("darwin with fake services reports the kind the fake stands in for", async () => {
    vi.stubEnv("AGEMON_FAKE_SERVICES", "1");
    vi.stubEnv("AGEMON_DEV", "1");

    const platform = await detectPlatformCapabilities({
      hostPlatform: "darwin",
    });

    expect(platform.serviceManager).toBe("systemd-user");
  });

  it("treats other host platforms as unsupported", async () => {
    const platform = await detectPlatformCapabilities({
      hostPlatform: "win32",
    });

    expect(platform.family).toBe("other");
    expect(platform.serviceManager).toBe("none");
    expect(platform.unsupportedReason).toContain(
      "agemon does not support win32.",
    );
  });

  it("reports systemd-user only when the systemd runtime directory exists", async () => {
    const root = await createTempDirectory();
    const osReleasePath = join(root, "os-release");
    await writeFile(osReleasePath, "ID=ubuntu\n");
    const systemdRuntimeDirectory = join(root, "run-systemd-system");

    const withoutSystemd = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
      systemdRuntimeDirectory,
    });
    await mkdir(systemdRuntimeDirectory);
    const withSystemd = await detectPlatformCapabilities({
      osReleasePath,
      hostPlatform: "linux",
      systemdRuntimeDirectory,
    });

    expect(withoutSystemd.serviceManager).toBe("none");
    expect(withSystemd.serviceManager).toBe("systemd-user");
  });

  it("honors the fake service manager only in dev mode", async () => {
    vi.stubEnv("AGEMON_FAKE_SERVICES", "1");
    vi.stubEnv("AGEMON_DEV", "");

    await expect(detectLinuxWith("ID=ubuntu\n")).rejects.toThrow(
      "must never be set outside the sandbox harness",
    );

    vi.stubEnv("AGEMON_DEV", "1");
    expect((await detectLinuxWith("ID=ubuntu\n")).serviceManager).toBe(
      "systemd-user",
    );
  });
});

describe("assertPlatformSupportsChanges", () => {
  it("throws UnsupportedPlatformError with the reason", async () => {
    const platform = await detectLinuxWith("ID=fedora\n");

    expect(() => assertPlatformSupportsChanges(platform)).toThrow(
      UnsupportedPlatformError,
    );
    expect(() => assertPlatformSupportsChanges(platform)).toThrow(
      platform.unsupportedReason ?? "",
    );
  });

  it("accepts a supported platform", async () => {
    const platform = await detectLinuxWith("ID=ubuntu\n");

    expect(() => assertPlatformSupportsChanges(platform)).not.toThrow();
  });
});

describe("detectRequiredBinaries", () => {
  it("does not report a required binary from an npm-injected node_modules/.bin", async () => {
    const root = await createTempDirectory();
    const plantedBin = join(root, "repo", "node_modules", ".bin");
    await mkdir(plantedBin, { recursive: true });
    await writeFile(join(plantedBin, "pipx"), "#!/bin/sh\n");
    await chmod(join(plantedBin, "pipx"), 0o755);
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("PATH", plantedBin);

    const binaries = await detectRequiredBinaries(
      agemonSubprocessEnvironment().PATH ?? "",
    );

    expect(binaries.pipx).toEqual({
      name: "pipx",
      present: false,
      path: undefined,
    });
  });
});
