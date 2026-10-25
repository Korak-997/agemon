import { join } from "node:path";
import { resolveHomeDirectory } from "../../platform/home.js";

const GIT_SAFETY_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
];

export function resolveCrgHome(): string {
  return join(resolveHomeDirectory(), ".code-review-graph");
}

function existingGitConfigCount(): number {
  const configured = process.env.GIT_CONFIG_COUNT ?? "";
  const count = Number(configured);
  return /^\d+$/.test(configured) && Number.isSafeInteger(count) ? count : 0;
}

const VARIABLES_CLEARED_FOR_CRG = ["CRG_DATA_DIR", "GIT_CONFIG_PARAMETERS"];

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
  };
}

export function crgUnitEnvironment(): {
  set: Record<string, string>;
  unset: string[];
} {
  return {
    set: { CRG_HOME: resolveCrgHome(), ...gitSafetyConfiguration(0) },
    unset: VARIABLES_CLEARED_FOR_CRG,
  };
}
