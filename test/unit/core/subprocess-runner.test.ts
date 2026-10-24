import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  MAX_CAPTURED_CHARACTERS_PER_STREAM,
  runSubprocess,
} from "../../../src/core/subprocess-runner.js";

const createdTempDirectories: string[] = [];
const TRUNCATION_MARKER = "…[truncated]";
const GRANDCHILD_TEST_TIMEOUT_MS = 15_000;
const LONE_SURROGATE = /\p{Cs}/u;

afterEach(async () => {
  vi.useRealTimers();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function runNodeScript(script: string) {
  return runSubprocess(process.execPath, ["-e", script]);
}

describe("runSubprocess", () => {
  it("runs the command in the directory the caller names", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "agemon-runner-test-")),
    );
    createdTempDirectories.push(directory);

    const result = await runSubprocess("pwd", [], { cwd: directory });

    expect(result.stdout.trim()).toBe(directory);
  });

  it("decodes a multi-byte character split across two writes", async () => {
    const result = await runNodeScript(
      [
        "const emoji = Buffer.from('😀');",
        "process.stdout.write(emoji.subarray(0, 2));",
        "setTimeout(() => process.stdout.write(emoji.subarray(2)), 50);",
      ].join("\n"),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("😀");
  });

  it("caps captured output and marks it as truncated", async () => {
    const result = await runNodeScript(
      `process.stdout.write("x".repeat(${MAX_CAPTURED_CHARACTERS_PER_STREAM + 1_000}));`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(
      MAX_CAPTURED_CHARACTERS_PER_STREAM + TRUNCATION_MARKER.length + 1,
    );
  });

  it("never splits a character in two at the cap", async () => {
    const result = await runNodeScript(
      `process.stdout.write("x" + "😀".repeat(${MAX_CAPTURED_CHARACTERS_PER_STREAM / 2}));`,
    );

    expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(LONE_SURROGATE.test(result.stdout)).toBe(false);
  });

  it("passes extra environment variables to the child on top of the parent's", async () => {
    const result = await runSubprocess(
      "sh",
      ["-c", 'echo "$AGEMON_TEST_VALUE"'],
      {
        env: { AGEMON_TEST_VALUE: "from-caller" },
      },
    );

    expect(result.stdout.trim()).toBe("from-caller");
  });

  it("times out a call that passes no timeout after the default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = runSubprocess("sleep", ["30"]);
    await vi.advanceTimersByTimeAsync(DEFAULT_SUBPROCESS_TIMEOUT_MS);
    vi.useRealTimers();
    const result = await pending;

    expect(result.code).toBe(124);
    expect(result.stderr).toContain(
      `timed out after ${DEFAULT_SUBPROCESS_TIMEOUT_MS}ms`,
    );
  });

  it(
    "returns a timeout even while a grandchild keeps the output pipes open",
    async () => {
      const startedAt = Date.now();

      const result = await runSubprocess("sh", ["-c", "sleep 8 & sleep 8"], {
        timeoutMs: 200,
      });

      expect(result.code).toBe(124);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    },
    GRANDCHILD_TEST_TIMEOUT_MS,
  );

  it(
    "returns a timeout for a child that ignores SIGTERM while a grandchild keeps the pipes open",
    async () => {
      const startedAt = Date.now();

      const result = await runSubprocess(
        "sh",
        ["-c", "trap '' TERM; sleep 8 & while :; do sleep 0.1; done"],
        { timeoutMs: 200 },
      );

      expect(result.code).toBe(124);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    },
    GRANDCHILD_TEST_TIMEOUT_MS,
  );

  it(
    "reports the real exit code when the child exits but a grandchild keeps the pipes open",
    async () => {
      const startedAt = Date.now();

      const result = await runSubprocess("sh", ["-c", "sleep 8 & echo done"], {
        timeoutMs: 60_000,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("done\n");
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    },
    GRANDCHILD_TEST_TIMEOUT_MS,
  );
});
