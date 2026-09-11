import { matchRuleFiles, matchStructuredConfigs } from "./discovery-adapter.js";
import type { AgentAdapter } from "./types.js";
import {
  extractSemverVersion,
  probeAgentInstallation,
  type VersionProbeSpec,
} from "./version-probe.js";

export const CLAUDE_PROBE_SPEC: VersionProbeSpec = {
  binaryName: "claude",
  versionArgs: ["--version"],
  parseVersion: extractSemverVersion,
  timeoutMs: 3000,
};

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  discoverProjectResources(discovery) {
    return [
      ...matchRuleFiles(discovery, ["CLAUDE.md"]),
      ...matchStructuredConfigs(discovery, [
        ".mcp.json",
        ".claude/settings.json",
      ]),
    ];
  },
  detectInstallation: (ctx) => probeAgentInstallation(ctx, CLAUDE_PROBE_SPEC),
};
