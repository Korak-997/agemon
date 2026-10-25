import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context, SubprocessResult } from "../../core/context.js";
import { resolveStateRoot } from "../../core/state-root.js";
import { printable } from "../../core/untrusted-text.js";

const SOURCE_DIRECTORY_MODE = 0o700;
const GIT_STEP_TIMEOUT_MS = 120_000;
const GIT_SYMLINK_MODE = "120000";
const GIT_WITHOUT_HOOKS_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

export interface PinnedSkillsRepository {
  url: string;
  commit: string;
}

type PinnedSourceContext = Pick<Context, "run">;

export function resolvePinnedSkillsSourceDirectory(commit: string): string {
  return join(resolveStateRoot(), "agemon", "skills-src", commit);
}

export function skillPathInRepository(skillName: string): string {
  return `skills/${skillName}`;
}

export function resolvePinnedSkillPath(
  repository: PinnedSkillsRepository,
  skillName: string,
): string {
  return join(
    resolvePinnedSkillsSourceDirectory(repository.commit),
    skillPathInRepository(skillName),
  );
}

function isolatedGitEnvironment(
  sourceDirectory: string,
): Record<string, string> {
  const gitDirectory = join(sourceDirectory, ".git");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: sourceDirectory,
    GIT_COMMON_DIR: gitDirectory,
    GIT_INDEX_FILE: join(gitDirectory, "index"),
    GIT_OBJECT_DIRECTORY: join(gitDirectory, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  };
}

async function runGitStep(
  ctx: PinnedSourceContext,
  sourceDirectory: string,
  subcommandArgs: string[],
): Promise<SubprocessResult> {
  const result = await ctx.run(
    "git",
    [...GIT_WITHOUT_HOOKS_ARGS, ...subcommandArgs],
    {
      cwd: sourceDirectory,
      timeoutMs: GIT_STEP_TIMEOUT_MS,
      env: isolatedGitEnvironment(sourceDirectory),
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `git ${subcommandArgs[0]} failed while fetching pinned skills: ${
        result.stderr.trim() || `exit ${result.code}`
      }`,
    );
  }
  return result;
}

function findSymlinkPaths(lsTreeOutput: string): string[] {
  return lsTreeOutput
    .split("\n")
    .filter((line) => line.startsWith(`${GIT_SYMLINK_MODE} `))
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

async function assertSkillIsPlainFiles(
  ctx: PinnedSourceContext,
  sourceDirectory: string,
  skillName: string,
): Promise<void> {
  const skillPath = skillPathInRepository(skillName);
  const listing = await runGitStep(ctx, sourceDirectory, [
    "ls-tree",
    "-r",
    "HEAD",
    "--",
    skillPath,
  ]);
  if (listing.stdout.trim().length === 0) {
    throw new Error(`The pinned skills commit has no ${skillPath}.`);
  }
  const symlinkPaths = findSymlinkPaths(listing.stdout);
  if (symlinkPaths.length > 0) {
    throw new Error(
      `Refusing to install pinned skills: ${symlinkPaths.map(printable).join(", ")} is a symlink.`,
    );
  }
}

export async function fetchPinnedSkillsSource(
  ctx: PinnedSourceContext,
  repository: PinnedSkillsRepository,
  skillNames: string[],
): Promise<void> {
  const sourceDirectory = resolvePinnedSkillsSourceDirectory(repository.commit);
  await rm(sourceDirectory, { recursive: true, force: true });
  await mkdir(sourceDirectory, {
    recursive: true,
    mode: SOURCE_DIRECTORY_MODE,
  });

  await runGitStep(ctx, sourceDirectory, ["init", "-q"]);
  await runGitStep(ctx, sourceDirectory, [
    "fetch",
    "--depth",
    "1",
    repository.url,
    repository.commit,
  ]);
  await runGitStep(ctx, sourceDirectory, ["checkout", "-q", "FETCH_HEAD"]);

  const head = (
    await runGitStep(ctx, sourceDirectory, ["rev-parse", "HEAD"])
  ).stdout.trim();
  if (head !== repository.commit) {
    throw new Error(
      `Pinned skills checkout mismatch: expected commit ${repository.commit}, got ${printable(head)}.`,
    );
  }

  for (const skillName of skillNames) {
    await assertSkillIsPlainFiles(ctx, sourceDirectory, skillName);
  }
}
