import { matchCopilotInstructions } from "./discovery-adapter.js";
import type { AgentAdapter, AgentInstallationEvidence } from "./types.js";

function copilotInstallationEvidence(): AgentInstallationEvidence {
  return {
    level: "configured",
    executablePath: null,
    version: null,
    evidence: [
      "Copilot has no standalone executable to probe; installation state stops at configured.",
    ],
  };
}

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  displayName: "GitHub Copilot",
  discoverProjectResources(discovery) {
    return matchCopilotInstructions(discovery);
  },
  detectInstallation: async () => copilotInstallationEvidence(),
};
