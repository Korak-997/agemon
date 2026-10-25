import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import type {
  RunSubprocessOptions,
  SubprocessResult,
} from "../../../src/core/subprocess-runner.js";
import {
  ensureSkillsCli,
  runSkillsCli,
} from "../../../src/plugins/skills/skills-cli.js";

const SKILLS_CLI_PATH_IN_TOOLS_DIR = join(
  "node_modules",
  "skills",
  "bin",
  "cli.mjs",
);

let stateHome: string;
let originalStateHome: string | undefined;

beforeEach(async () => {
  originalStateHome = process.env.XDG_STATE_HOME;
  stateHome = await mkdtemp(join(tmpdir(), "agemon-skills-cli-test-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
  process.env.XDG_STATE_HOME = originalStateHome;
  await rm(stateHome, { recursive: true, force: true });
});

function toolsRoot(): string {
  return join(stateHome, "agemon", "tools");
}

async function expectedToolsDirectory(): Promise<string> {
  const shippedLock = await readFile("assets/tools/package-lock.json");
  const lockHash = createHash("sha256")
    .update(shippedLock)
    .digest("hex")
    .slice(0, 16);
  return join(toolsRoot(), lockHash);
}

async function writeSkillsCliInto(toolsDirectory: string): Promise<void> {
  const cliPath = join(toolsDirectory, SKILLS_CLI_PATH_IN_TOOLS_DIR);
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "// skills cli\n", "utf8");
}

const OK: SubprocessResult = { code: 0, stdout: "", stderr: "" };

type RunCall = [string, string[], RunSubprocessOptions | undefined];

function createRunner(
  onNpmCi: (prefix: string) => Promise<SubprocessResult> = async (prefix) => {
    await writeSkillsCliInto(prefix);
    return OK;
  },
) {
  const run = vi.fn(
    async (
      command: string,
      args: string[],
      _options?: RunSubprocessOptions,
    ): Promise<SubprocessResult> => {
      if (command === "npm" && args[0] === "ci") {
        const prefix = args[args.indexOf("--prefix") + 1] ?? "";
        return onNpmCi(prefix);
      }
      return OK;
    },
  );
  const ctx = { run } as unknown as Pick<Context, "run">;
  const npmCiCalls = () =>
    (run.mock.calls as RunCall[]).filter(
      ([command, args]) => command === "npm" && args[0] === "ci",
    );
  return { ctx, run, npmCiCalls };
}

describe("ensureSkillsCli", () => {
  it("installs the shipped lockfile into a content-addressed tools dir", async () => {
    const { ctx, npmCiCalls } = createRunner();

    const cliPath = await ensureSkillsCli(ctx);

    const toolsDirectory = await expectedToolsDirectory();
    expect(cliPath).toBe(join(toolsDirectory, SKILLS_CLI_PATH_IN_TOOLS_DIR));
    expect(existsSync(cliPath)).toBe(true);
    expect(
      await readFile(join(toolsDirectory, "package-lock.json"), "utf8"),
    ).toBe(await readFile("assets/tools/package-lock.json", "utf8"));

    const [[, args, options]] = npmCiCalls();
    const prefix = args[args.indexOf("--prefix") + 1];
    expect(args).toEqual([
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
    ]);
    expect(dirname(prefix ?? "")).toBe(toolsRoot());
    expect(options?.cwd).toBe(prefix);
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(await readdir(toolsRoot())).toEqual([
      toolsDirectory.split("/").at(-1),
    ]);
  });

  it("reuses an installed tools dir without running npm ci", async () => {
    await writeSkillsCliInto(await expectedToolsDirectory());
    const { ctx, npmCiCalls } = createRunner();

    await ensureSkillsCli(ctx);

    expect(npmCiCalls()).toHaveLength(0);
  });

  it("installs alongside a tools dir left by another lockfile", async () => {
    const otherToolsDirectory = join(toolsRoot(), "0000000000000000");
    await writeSkillsCliInto(otherToolsDirectory);
    const { ctx, npmCiCalls } = createRunner();

    await ensureSkillsCli(ctx);

    expect(npmCiCalls()).toHaveLength(1);
    expect(existsSync(otherToolsDirectory)).toBe(true);
  });

  it("replaces a tools dir that has no skills CLI", async () => {
    const toolsDirectory = await expectedToolsDirectory();
    await mkdir(toolsDirectory, { recursive: true });
    await writeFile(join(toolsDirectory, "leftover"), "x", "utf8");
    const { ctx, npmCiCalls } = createRunner();

    const cliPath = await ensureSkillsCli(ctx);

    expect(npmCiCalls()).toHaveLength(1);
    expect(existsSync(cliPath)).toBe(true);
    expect(existsSync(join(toolsDirectory, "leftover"))).toBe(false);
  });

  it("removes its temp dir and installs nothing when npm ci fails", async () => {
    const { ctx } = createRunner(async () => ({
      code: 1,
      stdout: "",
      stderr: "npm ERR! integrity mismatch",
    }));

    await expect(ensureSkillsCli(ctx)).rejects.toThrow(/integrity mismatch/u);

    expect(await readdir(toolsRoot())).toEqual([]);
  });

  it("two concurrent repairs of a broken tools dir both succeed", async () => {
    const toolsDirectory = await expectedToolsDirectory();
    await mkdir(toolsDirectory, { recursive: true });
    await writeFile(join(toolsDirectory, "leftover"), "x", "utf8");
    const { ctx, npmCiCalls } = createRunner(async (prefix) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeSkillsCliInto(prefix);
      return OK;
    });

    const [first, second] = await Promise.all([
      ensureSkillsCli(ctx),
      ensureSkillsCli(ctx),
    ]);

    expect(first).toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(npmCiCalls()).toHaveLength(1);
  });

  it("uses the winner's tools dir when a concurrent run installs first", async () => {
    const toolsDirectory = await expectedToolsDirectory();
    const { ctx } = createRunner(async (prefix) => {
      await writeSkillsCliInto(prefix);
      await writeSkillsCliInto(toolsDirectory);
      await writeFile(join(toolsDirectory, "winner"), "x", "utf8");
      return OK;
    });

    const cliPath = await ensureSkillsCli(ctx);

    expect(cliPath).toBe(join(toolsDirectory, SKILLS_CLI_PATH_IN_TOOLS_DIR));
    expect(existsSync(join(toolsDirectory, "winner"))).toBe(true);
    expect(await readdir(toolsRoot())).toEqual([
      toolsDirectory.split("/").at(-1),
    ]);
  });
});

describe("runSkillsCli", () => {
  it("runs the pinned CLI with this Node binary, in the caller's cwd", async () => {
    const { ctx, run } = createRunner();

    await runSkillsCli(ctx, ["list", "--json"], 30_000);

    const toolsDirectory = await expectedToolsDirectory();
    expect(run).toHaveBeenLastCalledWith(
      process.execPath,
      [join(toolsDirectory, SKILLS_CLI_PATH_IN_TOOLS_DIR), "list", "--json"],
      { timeoutMs: 30_000 },
    );
  });
});
