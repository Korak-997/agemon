import {
  runRealSubprocess,
  type SubprocessResult,
} from "./subprocess-runner.js";

const REPOSITORY_GIT_TIMEOUT_MS = 5_000;

export const HARDENED_GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export const REPOSITORY_LOCAL_GIT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

export const GIT_TRANSPORTS_DISABLED: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
};

export function runRepositoryGit(
  directory: string,
  args: string[],
): Promise<SubprocessResult> {
  return runRealSubprocess(
    "git",
    [...HARDENED_GIT_ARGS, "-C", directory, ...args],
    {
      timeoutMs: REPOSITORY_GIT_TIMEOUT_MS,
      env: { ...GIT_TRANSPORTS_DISABLED },
      unsetEnv: REPOSITORY_LOCAL_GIT_VARIABLES,
    },
  );
}
