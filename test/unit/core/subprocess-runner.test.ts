import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("runSubprocess", () => {
  it("runs the command in the directory the caller names", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "agemon-runner-test-")),
    );
    createdTempDirectories.push(directory);

    const result = await runSubprocess("pwd", [], { cwd: directory });

    expect(result.stdout.trim()).toBe(directory);
  });
});
