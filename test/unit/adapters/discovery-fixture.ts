import {
  type DiscoveryResult,
  ROOT_RULE_FILES,
  STRUCTURED_CONFIG_FILES,
} from "../../../src/inspect/discover.js";

export function buildDiscoveryResult(
  overrides: Partial<DiscoveryResult> = {},
): DiscoveryResult {
  return {
    ruleFiles: ROOT_RULE_FILES.map((path) => ({
      kind: "rule-file" as const,
      path,
      exists: false,
      contents: null,
    })),
    copilotInstructions: [],
    structuredConfigs: STRUCTURED_CONFIG_FILES.map((path) => ({
      kind: "structured-config" as const,
      path,
      exists: false,
      parsed: null,
      parseError: null,
      denylisted: false,
    })),
    binaries: [],
    isolation: { status: "no-gitignore-file", trackedAgemonPaths: [] },
    ...overrides,
  };
}
