import { matchRuleFiles, matchStructuredConfigs } from "./discovery-adapter.js";
import type { AgentAdapter } from "./types.js";
import {
  extractSemverVersion,
  probeAgentInstallation,
  probeAgentUsability,
  type UsabilityProbeSpec,
  type VersionProbeSpec,
} from "./version-probe.js";

export const GEMINI_PROBE_SPEC: VersionProbeSpec = {
  binaryName: "gemini",
  versionArgs: ["--version"],
  parseVersion: extractSemverVersion,
  timeoutMs: 3000,
};
export const GEMINI_USABILITY_PROBE_SPEC: UsabilityProbeSpec = {
  usabilityArgs: ["mcp", "list"],
  timeoutMs: 5000,
};

export const geminiCliAdapter: AgentAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  discoverProjectResources(discovery) {
    return [
      ...matchRuleFiles(discovery, ["GEMINI.md"]),
      ...matchStructuredConfigs(discovery, [".gemini/settings.json"]),
    ];
  },
  detectInstallation: (ctx) => probeAgentInstallation(ctx, GEMINI_PROBE_SPEC),
  detectUsability: (ctx, installation) =>
    probeAgentUsability(ctx, installation, GEMINI_USABILITY_PROBE_SPEC),
};
