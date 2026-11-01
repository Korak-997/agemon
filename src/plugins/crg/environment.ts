import { join } from "node:path";
import {
  GIT_TRANSPORTS_DISABLED,
  REPOSITORY_LOCAL_GIT_VARIABLES,
} from "../../core/repository-git.js";
import { resolveHomeDirectory } from "../../platform/home.js";

const GIT_SAFETY_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.ignoreSubmodules", "all"],
];

const VARIABLES_CLEARED_FOR_CRG = ["CRG_DATA_DIR", "GIT_CONFIG_PARAMETERS"];

export const REPOSITORY_LOCAL_VARIABLES_REMOVED_FOR_CRG =
  REPOSITORY_LOCAL_GIT_VARIABLES.filter(
    (variable) =>
      variable !== "GIT_CONFIG_COUNT" &&
      !VARIABLES_CLEARED_FOR_CRG.includes(variable),
  );

export function resolveCrgHome(): string {
  return join(resolveHomeDirectory(), ".code-review-graph");
}

function existingGitConfigCount(): number {
  const configured = process.env.GIT_CONFIG_COUNT ?? "";
  const count = Number(configured);
  return /^\d+$/.test(configured) && Number.isSafeInteger(count) ? count : 0;
}

function gitSafetyConfiguration(firstIndex: number): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_COUNT: String(firstIndex + GIT_SAFETY_CONFIG.length),
  };
  GIT_SAFETY_CONFIG.forEach(([key, value], offset) => {
    environment[`GIT_CONFIG_KEY_${firstIndex + offset}`] = key;
    environment[`GIT_CONFIG_VALUE_${firstIndex + offset}`] = value;
  });
  return environment;
}

export function crgSubprocessEnvironment(): Record<string, string> {
  return {
    CRG_HOME: resolveCrgHome(),
    ...Object.fromEntries(
      VARIABLES_CLEARED_FOR_CRG.map((variable) => [variable, ""]),
    ),
    ...gitSafetyConfiguration(existingGitConfigCount()),
    ...GIT_TRANSPORTS_DISABLED,
  };
}

export function crgUnitGitSafetyEnvironment(): Record<string, string> {
  return { ...gitSafetyConfiguration(0), ...GIT_TRANSPORTS_DISABLED };
}

export function crgUnitEnvironment(): {
  set: Record<string, string>;
  unset: string[];
  removedRepositoryLocal: string[];
} {
  return {
    set: {
      CRG_HOME: resolveCrgHome(),
      ...crgUnitGitSafetyEnvironment(),
    },
    unset: VARIABLES_CLEARED_FOR_CRG,
    removedRepositoryLocal: REPOSITORY_LOCAL_VARIABLES_REMOVED_FOR_CRG,
  };
}
