import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agemonSubprocessEnvironment,
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
  vi.unstubAllEnvs();
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

describe("agemonSubprocessEnvironment", () => {
  const NPM_LAUNCH_VARIABLES = [
    ["npm_command", "exec"],
    ["npm_execpath", "/usr/lib/node_modules/npm/bin/npm-cli.js"],
    ["npm_config_user_agent", "pnpm/9.0.0 npm/? node/v22.12.0 linux x64"],
  ] as const;

  it("drops empty and relative PATH entries in every launch mode", () => {
    const environment = agemonSubprocessEnvironment({
      PATH: "/usr/bin::.:bin:/home/u/.local/bin:",
    });

    expect(environment.PATH).toBe("/usr/bin:/home/u/.local/bin");
  });

  it("keeps a user's own npm config when npm did not launch agemon", () => {
    const environment = agemonSubprocessEnvironment({
      PATH: "/usr/bin:/home/u/project/node_modules/.bin",
      NPM_CONFIG_PREFIX: "/home/u/.npm-global",
      npm_config_cafile: "/etc/ssl/corp.pem",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin:/home/u/project/node_modules/.bin",
      NPM_CONFIG_PREFIX: "/home/u/.npm-global",
      npm_config_cafile: "/etc/ssl/corp.pem",
    });
  });

  it.each(NPM_LAUNCH_VARIABLES)(
    "drops npm's injected variables and bin dirs when %s shows an npm launch",
    (name, value) => {
      const environment = agemonSubprocessEnvironment({
        [name]: value,
        PATH: "/repo/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/usr/bin",
        npm_config_registry: "https://evil.example/",
        NPM_CONFIG_USERCONFIG: "/repo/.npmrc",
        npm_package_name: "hostile",
        npm_lifecycle_event: "postinstall",
        INIT_CWD: "/repo",
        NODE: "/usr/bin/node",
        HOME: "/home/u",
        NODE_OPTIONS: "--max-old-space-size=4096",
      });

      expect(environment).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/u",
        NODE_OPTIONS: "--max-old-space-size=4096",
      });
    },
  );

  it("is the base environment every child process gets", async () => {
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("npm_config_registry", "https://evil.example/");

    const result = await runSubprocess("sh", [
      "-c",
      "printenv npm_config_registry || echo unset",
    ]);

    expect(result.stdout.trim()).toBe("unset");
  });
});
