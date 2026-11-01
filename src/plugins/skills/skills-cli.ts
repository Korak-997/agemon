import { existsSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import type { Context, SubprocessResult } from "../../core/context.js";
import { sha256Hex } from "../../core/fingerprint.js";
import { resolveToolsManifestDirectory } from "../../core/package-assets.js";
import {
  prepareToolsRoot,
  withAgemonStateLock,
} from "../../core/state-root.js";
import { describeSubprocessFailure } from "../../core/subprocess-runner.js";

const TOOLS_LOCK_HASH_LENGTH = 16;
const TOOLS_INSTALL_TIMEOUT_MS = 180_000;
const TOOLS_LOCK_WAIT_MS = 10 * 60_000;
const TOOLS_MANIFEST_FILES = ["package.json", "package-lock.json"];
export const SKILLS_CLI_PATH_IN_TOOLS_DIR = join(
  "node_modules",
  "skills",
  "bin",
  "cli.mjs",
);

type SkillsCliContext = Pick<Context, "run">;

function isLostInstallRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function renameUnlessAnotherRunWon(
  stagingDirectory: string,
  toolsDirectory: string,
): Promise<boolean> {
  try {
    await rename(stagingDirectory, toolsDirectory);
    return true;
  } catch (error) {
    if (isLostInstallRace(error)) {
      return false;
    }
    throw error;
  }
}
async function promoteStagingDirectory(
  stagingDirectory: string,
  toolsDirectory: string,
  cliPath: string,
): Promise<void> {
  if (await renameUnlessAnotherRunWon(stagingDirectory, toolsDirectory)) {
    return;
  }
  if (existsSync(cliPath)) {
    return;
  }
  const brokenDirectory = `${stagingDirectory}.broken`;
  await rename(toolsDirectory, brokenDirectory);
  await rm(brokenDirectory, { recursive: true, force: true });
  await renameUnlessAnotherRunWon(stagingDirectory, toolsDirectory);
}

const ABANDONED_TOOLS_DIRECTORY_PATTERN = /^[0-9a-f]{16}\.tmp-[^/]+$/;

async function removeAbandonedToolsDirectories(
  toolsRoot: string,
): Promise<void> {
  for (const entry of await readdir(toolsRoot)) {
    if (ABANDONED_TOOLS_DIRECTORY_PATTERN.test(entry)) {
      await rm(join(toolsRoot, entry), { recursive: true, force: true });
    }
  }
}

async function installToolsDirectory(
  ctx: SkillsCliContext,
  toolsRoot: string,
  manifestDirectory: string,
  toolsDirectory: string,
  cliPath: string,
): Promise<void> {
  await removeAbandonedToolsDirectories(toolsRoot);
  const stagingDirectory = await mkdtemp(`${toolsDirectory}.tmp-`);
  try {
    for (const fileName of TOOLS_MANIFEST_FILES) {
      await copyFile(
        join(manifestDirectory, fileName),
        join(stagingDirectory, fileName),
      );
    }
    const installResult = await ctx.run(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        stagingDirectory,
      ],
      { cwd: stagingDirectory, timeoutMs: TOOLS_INSTALL_TIMEOUT_MS },
    );
    if (installResult.code !== 0) {
      throw new Error(
        `Installing the pinned skills CLI into ${toolsRoot} failed: ${describeSubprocessFailure(installResult, "npm ci")}`,
      );
    }
    await promoteStagingDirectory(stagingDirectory, toolsDirectory, cliPath);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function ensureSkillsCli(ctx: SkillsCliContext): Promise<string> {
  const manifestDirectory = resolveToolsManifestDirectory();
  const lockHash = sha256Hex(
    await readFile(join(manifestDirectory, "package-lock.json")),
  ).slice(0, TOOLS_LOCK_HASH_LENGTH);
  const toolsRoot = await prepareToolsRoot();
  const toolsDirectory = join(toolsRoot, lockHash);
  const cliPath = join(toolsDirectory, SKILLS_CLI_PATH_IN_TOOLS_DIR);

  if (existsSync(cliPath)) {
    return cliPath;
  }

  await withAgemonStateLock(
    "tools.lock",
    async () => {
      if (!existsSync(cliPath)) {
        await installToolsDirectory(
          ctx,
          toolsRoot,
          manifestDirectory,
          toolsDirectory,
          cliPath,
        );
      }
    },
    TOOLS_LOCK_WAIT_MS,
  );
  return cliPath;
}

export async function runSkillsCli(
  ctx: Pick<Context, "run" | "cwd">,
  args: string[],
  timeoutMs: number,
): Promise<SubprocessResult> {
  const cliPath = await ensureSkillsCli(ctx);
  return ctx.run(process.execPath, [cliPath, ...args], {
    cwd: ctx.cwd,
    timeoutMs,
  });
}
