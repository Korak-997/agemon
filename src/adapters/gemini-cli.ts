import { matchRuleFiles, matchStructuredConfigs } from "./discovery-adapter.js";
import type { AgentAdapter } from "./types.js";
import {
  extractSemverVersion,
  probeAgentInstallation,
  type VersionProbeSpec,
} from "./version-probe.js";

export const GEMINI_PROBE_SPEC: VersionProbeSpec = {
  binaryName: "gemini",
  versionArgs: ["--version"],
  parseVersion: extractSemverVersion,
  timeoutMs: 3000,
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
};
