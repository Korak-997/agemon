import { describe, expect, it } from "vitest";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import { traceSubprocessCalls } from "../../../src/core/subprocess-trace.js";

function tracedRun(result: SubprocessResult): {
  run: ReturnType<typeof traceSubprocessCalls>;
  printed: string[];
} {
  const printed: string[] = [];
  const run = traceSubprocessCalls(async () => result, {
    info: (line) => printed.push(line),
  });
  return { run, printed };
}

describe("traceSubprocessCalls", () => {
  it("prints the command line, its exit code and its output beneath the step", async () => {
    const { run, printed } = tracedRun({
      code: 0,
      stdout: "installed skills\n",
      stderr: "warn: slow network\n",
    });

    await expect(
      run("npx", ["--yes", "skills", "add", "x"]),
    ).resolves.toMatchObject({ code: 0 });

    expect(printed).toEqual([
      "$ npx --yes skills add x (exit 0)",
      "│ installed skills",
      "│ ! warn: slow network",
    ]);
  });

  it("redacts secrets in arguments and output", async () => {
    const { run, printed } = tracedRun({
      code: 1,
      stdout: "api_key=abc123 accepted\n",
      stderr: "",
    });

    await run("tool", ["--token", "s3cr3t-value"]);

    expect(printed.join("\n")).not.toContain("s3cr3t-value");
    expect(printed.join("\n")).not.toContain("abc123");
    expect(printed[0]).toBe(
      "$ tool --token <redacted:credential-key> (exit 1)",
    );
  });

  it("keeps the last 20 lines of a stream and counts the rest", async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
    const { run, printed } = tracedRun({
      code: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    });

    await run("npm", ["install"]);

    expect(printed[1]).toBe("│ … 5 earlier lines");
    expect(printed.slice(2)).toEqual(lines.slice(5).map((line) => `│ ${line}`));
  });

  it("redacts a PEM block whose BEGIN line the 20-line tail cut off", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      ...Array.from({ length: 30 }, () => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"),
      "ab=",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const { run, printed } = tracedRun({ code: 0, stdout: pem, stderr: "" });

    await run("cat", ["key.pem"]);

    expect(printed.slice(1)).toEqual([
      "│ … 13 earlier lines",
      "│ <redacted:pem>",
    ]);
  });

  it("redacts a whole PEM block that fits in the tail", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const { run, printed } = tracedRun({ code: 0, stdout: pem, stderr: "" });

    await run("cat", ["key.pem"]);

    expect(printed.slice(1)).toEqual(["│ <redacted:pem>"]);
  });

  it("escapes terminal control characters in output", async () => {
    const { run, printed } = tracedRun({
      code: 0,
      stdout: `title${String.fromCharCode(27)}]0;pwned\n`,
      stderr: "",
    });

    await run("x", []);

    expect(printed[1]).toBe("│ title?]0;pwned");
  });

  it("redacts a secret that a tool printed in colour", async () => {
    const escapeCharacter = String.fromCharCode(27);
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { run, printed } = tracedRun({
      code: 0,
      stdout: `${escapeCharacter}[31m${jwt}${String.fromCharCode(0x9b)}0m\n`,
      stderr: "",
    });

    await run("x", []);

    expect(printed[1]).toBe("│ <redacted:jwt>");
  });

  it("caps a very long line", async () => {
    const { run, printed } = tracedRun({
      code: 0,
      stdout: `${"word ".repeat(200)}\n`,
      stderr: "",
    });

    await run("x", []);

    expect(printed[1]).toHaveLength("│ ".length + 300 + 1);
    expect(printed[1].endsWith("…")).toBe(true);
  });
});
