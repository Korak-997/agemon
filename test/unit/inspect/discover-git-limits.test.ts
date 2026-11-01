import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { TRUNCATION_MARKER } from "../../../src/core/subprocess-runner.js";
import { discoverRepository } from "../../../src/inspect/discover.js";

vi.mock("../../../src/core/repository-git.js", () => ({
  runRepositoryGit: async (_directory: string, args: string[]) =>
    args[0] === "ls-files"
      ? {
          code: 0,
          stdout: `.agemon/state.json${TRUNCATION_MARKER}`,
          stderr: "",
        }
      : { code: 1, stdout: "", stderr: "" },
}));

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("discoverRepository with git output limits", () => {
  it("treats truncated ls-files output as a tracking-check error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agemon-discover-limits-"));
    createdTempDirectories.push(cwd);
    await mkdir(join(cwd, ".git"));

    const discovery = await discoverRepository({
      cwd,
      binaries: [],
    } as unknown as Context);

    expect(discovery.isolation.trackedAgemonPaths).toEqual([]);
    expect(discovery.isolation.trackingCheckError).toBe(
      "could not check whether .agemon/ is tracked by git: git ls-files output exceeded the capture limit",
    );
  });
});
