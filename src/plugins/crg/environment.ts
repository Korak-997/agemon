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

function crgGitSafetyEnvironment(): Record<string, string> {
  const firstIndex = existingGitConfigCount();
  const environment: Record<string, string> = {
    GIT_CONFIG_PARAMETERS: "",
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
    CRG_DATA_DIR: "",
    ...crgGitSafetyEnvironment(),
  };
}
