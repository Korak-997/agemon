import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const SANDBOX_SCRIPT = join(REPOSITORY_ROOT, "scripts", "sandbox.ts");
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SANDBOX_TIMEOUT_MS = 60_000;

const SANDBOX_ENVIRONMENT_KEYS = [
  "AGEMON_DEV",
  "AGEMON_FAKE_SERVICES",
  "AGEMON_FAKE_SUBPROCESS",
  "HOME",
  "XDG_STATE_HOME",
];

let runsRoot: string;

beforeEach(() => {
  runsRoot = mkdtempSync(join(tmpdir(), "agemon-sandbox-prepare-"));
});

afterEach(() => {
  rmSync(runsRoot, { recursive: true, force: true });
});

function sandbox(...args: string[]) {
  return spawnSync(TSX, [SANDBOX_SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: SANDBOX_TIMEOUT_MS,
  });
}

function sourcedEnvironment(script: string): Record<string, string> {
  const output = execFileSync(
    "sh",
    ["-c", `${script}\nprintf 'PWD=%s\\n' "$PWD"\nenv`],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
}

describe("sandbox prepare", () => {
  it(
    "prints the sandbox environment and a cd into a committed, clean fixture repo",
    () => {
      const result = sandbox(
        "prepare",
        "clean-repo",
        "--label",
        "recording-roundtrip",
        "--runs-root",
        runsRoot,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(
        result.stdout
          .trim()
          .split("\n")
          .every((line) => /^(export [A-Z_]+=|cd )'/u.test(line)),
      ).toBe(true);

      const environment = sourcedEnvironment(result.stdout);
      const runDirectory = join(runsRoot, "recording-roundtrip");
      expect(environment.PWD).toBe(join(runDirectory, "repo"));
      expect(environment.HOME).toBe(join(runDirectory, "home"));
      expect(environment.XDG_STATE_HOME).toBe(
        join(runDirectory, "home", ".local", "state"),
      );
      expect(environment.AGEMON_DEV).toBe("1");
      expect(environment.AGEMON_FAKE_SUBPROCESS).toBe("1");
      expect(environment.AGEMON_FAKE_SERVICES).toBe("1");
      expect(
        result.stdout
          .match(/^export ([A-Z_]+)=/gmu)
          ?.map((line) => line.slice("export ".length, -1))
          .sort(),
      ).toEqual(SANDBOX_ENVIRONMENT_KEYS);

      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: join(runDirectory, "repo"),
        encoding: "utf8",
      });
      expect(status).toBe("");
    },
    SANDBOX_TIMEOUT_MS,
  );

  it(
    "names the paths as the recording container sees them with --shell-runs-root",
    () => {
      const result = sandbox(
        "prepare",
        "clean-repo",
        "--label",
        "recording-roundtrip",
        "--runs-root",
        runsRoot,
        "--shell-runs-root",
        "/work",
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "export HOME='/work/recording-roundtrip/home'\n",
      );
      expect(result.stdout).toContain("cd '/work/recording-roundtrip/repo'\n");
      expect(result.stdout).not.toContain(runsRoot);
      const secondRunsRoot = mkdtempSync(
        join(tmpdir(), "agemon-sandbox-prepare-"),
      );
      const relativeShellRoot = sandbox(
        "prepare",
        "clean-repo",
        "--label",
        "other",
        "--runs-root",
        secondRunsRoot,
        "--shell-runs-root",
        "work",
      );
      rmSync(secondRunsRoot, { recursive: true, force: true });
      expect(relativeShellRoot.stderr).toMatch(
        /--shell-runs-root must be an absolute path/u,
      );
    },
    SANDBOX_TIMEOUT_MS,
  );

  it(
    "keeps a value with a single quote intact when sourced",
    () => {
      const quotedRunsRoot = join(runsRoot, "it's here");
      mkdirSync(quotedRunsRoot);
      const result = sandbox(
        "prepare",
        "clean-repo",
        "--label",
        "quoted",
        "--runs-root",
        quotedRunsRoot,
      );
      expect(result.status).toBe(0);
      expect(sourcedEnvironment(result.stdout).PWD).toBe(
        join(quotedRunsRoot, "quoted", "repo"),
      );
    },
    SANDBOX_TIMEOUT_MS,
  );

  it(
    "refuses unsafe labels and fixtures, other flags and an unusable runs root",
    () => {
      const notEmpty = mkdtempSync(join(tmpdir(), "agemon-not-empty-"));
      writeFileSync(join(notEmpty, "file"), "");
      const linkIntoRepository = join(notEmpty, "link");
      symlinkSync(join(REPOSITORY_ROOT, "test"), linkIntoRepository);
      const refused: [string[], RegExp][] = [
        [["--label", "../x", "--runs-root", runsRoot], /label/u],
        [["--label", "A", "--runs-root", runsRoot], /label/u],
        [["--runs-root", runsRoot], /--label/u],
        [["--label", "ok"], /--runs-root/u],
        [["--label", "ok", "--runs-root", "relative"], /absolute/u],
        [["--label", "ok", "--runs-root", notEmpty], /empty/u],
        [
          ["--label", "ok", "--runs-root", join(REPOSITORY_ROOT, "test")],
          /outside the repository/u,
        ],
        [
          ["--label", "ok", "--runs-root", linkIntoRepository],
          /outside the repository/u,
        ],
        [
          ["--label", "ok", "--runs-root", join(runsRoot, "missing")],
          /existing, empty directory/u,
        ],
        [["--label", "ok", "--runs-root", runsRoot, "--real"], /--real/u],
      ];
      for (const [flags, message] of refused) {
        const result = sandbox("prepare", "clean-repo", ...flags);
        expect(result.status, flags.join(" ")).not.toBe(0);
        expect(result.stderr, flags.join(" ")).toMatch(message);
      }
      rmSync(notEmpty, { recursive: true, force: true });
      const badFixture = sandbox(
        "prepare",
        "../fixtures",
        "--label",
        "ok",
        "--runs-root",
        runsRoot,
      );
      expect(badFixture.status).not.toBe(0);
      expect(badFixture.stderr).toMatch(/fixture/u);
    },
    SANDBOX_TIMEOUT_MS,
  );

  it(
    "keeps run working without --label and refuses an unsafe --label there too",
    () => {
      const withDefaultLabel = sandbox(
        "run",
        "clean-repo",
        "--dry-run",
        "--quiet",
      );
      expect(withDefaultLabel.status).toBe(0);

      const traversal = sandbox("run", "clean-repo", "--label", "../x");
      expect(traversal.status).not.toBe(0);
      expect(traversal.stderr).toMatch(/label/u);
    },
    SANDBOX_TIMEOUT_MS,
  );
});
