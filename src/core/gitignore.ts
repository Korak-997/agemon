import { join } from "node:path";
import { readRegularFileIfExists, writeFileAtomic } from "./files.js";
import { hasGitEntry } from "./repo-paths.js";
import { runRepositoryGit } from "./repository-git.js";
import {
  describeSubprocessFailure,
  isSpawnFailure,
} from "./subprocess-runner.js";

const GITIGNORE_FILENAME = ".gitignore";
export const AGEMON_GITIGNORE_ENTRY = "/.agemon/";
export const SKILLS_LOCK_GITIGNORE_ENTRY = "/skills-lock.json";
const GIT_CHECK_IGNORE_IGNORED = 0;
const GIT_CHECK_IGNORE_NOT_IGNORED = 1;

export type AgemonStateIgnoreVerdict =
  | { kind: "ignored" }
  | { kind: "not-ignored" }
  | { kind: "not-a-repository" }
  | { kind: "failed"; detail: string };

function normalizeIgnoreLine(line: string): string {
  return line.trim().replace(/^\//, "").replace(/\/$/, "");
}

export function gitignoreListsEntry(contents: string, entry: string): boolean {
  const normalizedEntry = normalizeIgnoreLine(entry);
  return contents
    .split(/\r?\n/)
    .some((line) => normalizeIgnoreLine(line) === normalizedEntry);
}

export function gitignoreListsAgemonState(contents: string): boolean {
  return gitignoreListsEntry(contents, AGEMON_GITIGNORE_ENTRY);
}

export async function gitIgnoresAgemonState(
  cwd: string,
): Promise<AgemonStateIgnoreVerdict> {
  const result = await runRepositoryGit(cwd, [
    "check-ignore",
    "-q",
    "--no-index",
    "--",
    ".agemon/",
  ]);
  if (!isSpawnFailure(result)) {
    if (result.code === GIT_CHECK_IGNORE_IGNORED) {
      return { kind: "ignored" };
    }
    if (result.code === GIT_CHECK_IGNORE_NOT_IGNORED) {
      return { kind: "not-ignored" };
    }
  }
  if (!(await hasGitEntry(cwd))) {
    return { kind: "not-a-repository" };
  }
  return {
    kind: "failed",
    detail: describeSubprocessFailure(result, "git check-ignore"),
  };
}

async function appendGitignoreEntry(
  gitignorePath: string,
  contents: string | null,
  entry: string,
): Promise<void> {
  if (contents === null) {
    await writeFileAtomic(gitignorePath, `${entry}\n`);
    return;
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    contents.length === 0 || contents.endsWith("\n") ? "" : newline;
  await writeFileAtomic(
    gitignorePath,
    `${contents}${separator}${entry}${newline}`,
  );
}

export interface GitignoreWrite {
  added: boolean;
  existedBefore: boolean;
  contentsBefore: string | null;
}

async function appendUnlessCovered(
  cwd: string,
  entry: string,
  isCovered: (contents: string) => boolean,
): Promise<GitignoreWrite> {
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);
  const contents = await readRegularFileIfExists(gitignorePath);
  const before = { existedBefore: contents !== null, contentsBefore: contents };
  if (contents !== null && isCovered(contents)) {
    return { added: false, ...before };
  }
  await appendGitignoreEntry(gitignorePath, contents, entry);
  return { added: true, ...before };
}

export function ensureGitignoreEntry(
  cwd: string,
  entry: string,
): Promise<GitignoreWrite> {
  return appendUnlessCovered(cwd, entry, (contents) =>
    gitignoreListsEntry(contents, entry),
  );
}

function lastRuleIsEntry(contents: string, entry: string): boolean {
  const lastRule = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .at(-1);
  return (
    lastRule !== undefined &&
    normalizeIgnoreLine(lastRule) === normalizeIgnoreLine(entry)
  );
}

export function writeAgemonGitignoreEntry(
  cwd: string,
): Promise<GitignoreWrite> {
  return appendUnlessCovered(cwd, AGEMON_GITIGNORE_ENTRY, (contents) =>
    lastRuleIsEntry(contents, AGEMON_GITIGNORE_ENTRY),
  );
}
