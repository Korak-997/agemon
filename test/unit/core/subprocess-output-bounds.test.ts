import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeSubprocessFailure,
  MAX_RAW_OUTPUT_LINE_CHARACTERS,
} from "../../../src/core/subprocess-runner.js";
import { traceSubprocessCalls } from "../../../src/core/subprocess-trace.js";

const redactedInputLengths: number[] = [];

vi.mock("../../../src/inspect/redact.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/inspect/redact.js")>();
  return {
    ...original,
    redactSecretsInText: (text: string) => {
      redactedInputLengths.push(text.length);
      return original.redactSecretsInText(text);
    },
  };
});

const GENEROUS_TIME_BOUND_MS = 5_000;
const ONE_MEBIBYTE_TOKEN = "a1B2".repeat(256 * 1024);

afterEach(() => {
  redactedInputLengths.length = 0;
});

describe("redaction input stays bounded for huge subprocess output", () => {
  it("describes a 1 MiB single-token stderr from at most 10 pre-capped lines", () => {
    const startedAt = Date.now();

    describeSubprocessFailure(
      { code: 1, stdout: "", stderr: ONE_MEBIBYTE_TOKEN },
      "tool",
    );

    expect(Math.max(...redactedInputLengths)).toBeLessThanOrEqual(
      10 * (MAX_RAW_OUTPUT_LINE_CHARACTERS + 1),
    );
    expect(Date.now() - startedAt).toBeLessThan(GENEROUS_TIME_BOUND_MS);
  });

  it("traces a 1 MiB single-token stream from at most 20 pre-capped lines", async () => {
    const run = traceSubprocessCalls(
      async () => ({ code: 0, stdout: ONE_MEBIBYTE_TOKEN, stderr: "" }),
      { info: () => {} },
    );
    const startedAt = Date.now();

    await run("tool", []);

    expect(Math.max(...redactedInputLengths)).toBeLessThanOrEqual(
      20 * (MAX_RAW_OUTPUT_LINE_CHARACTERS + 1),
    );
    expect(Date.now() - startedAt).toBeLessThan(GENEROUS_TIME_BOUND_MS);
  });
});
