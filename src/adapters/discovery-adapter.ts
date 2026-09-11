import type { DiscoveryResult } from "../inspect/discover.js";
import type { DiscoveredAgentResource } from "./types.js";

export function matchRuleFiles(
  discovery: DiscoveryResult,
  paths: readonly string[],
): DiscoveredAgentResource[] {
  return discovery.ruleFiles
    .filter((ruleFile) => paths.includes(ruleFile.path))
    .map((ruleFile) => ({
      path: ruleFile.path,
      kind: "rule-file",
      exists: ruleFile.exists,
    }));
}

export function matchStructuredConfigs(
  discovery: DiscoveryResult,
  paths: readonly string[],
): DiscoveredAgentResource[] {
  return discovery.structuredConfigs
    .filter((config) => paths.includes(config.path))
    .map((config) => ({
      path: config.path,
      kind: "structured-config",
      exists: config.exists,
    }));
}

export function matchCopilotInstructions(
  discovery: DiscoveryResult,
): DiscoveredAgentResource[] {
  return discovery.copilotInstructions.map((instruction) => ({
    path: instruction.path,
    kind: "copilot-instruction",
    exists: instruction.exists,
  }));
}
