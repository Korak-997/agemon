import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatform } from "../../../src/platform/detect.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("detectPlatform", () => {
  it("does not report a required binary from an npm-injected node_modules/.bin", async () => {
    const root = await mkdtemp(join(tmpdir(), "agemon-detect-test-"));
    createdTempDirectories.push(root);
    const osReleasePath = join(root, "os-release");
    await writeFile(osReleasePath, "ID=ubuntu\n");
    const plantedBin = join(root, "repo", "node_modules", ".bin");
    await mkdir(plantedBin, { recursive: true });
    await writeFile(join(plantedBin, "pipx"), "#!/bin/sh\n");
    await chmod(join(plantedBin, "pipx"), 0o755);
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("PATH", plantedBin);

    const detection = await detectPlatform({ osReleasePath });

    expect(detection.binaries.pipx).toEqual({
      name: "pipx",
      present: false,
      path: undefined,
    });
  });
});
