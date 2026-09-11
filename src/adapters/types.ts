import type { Context } from "../core/context.js";
import type { DiscoveryResult } from "../inspect/discover.js";

export type AgentAvailabilityLevel = "configured" | "installed" | "usable";

export interface AgentInstallationEvidence {
  level: AgentAvailabilityLevel;
  executablePath: string | null;
  version: string | null;
  evidence: string[];
}

export interface DiscoveredAgentResource {
  path: string;
  kind: "rule-file" | "structured-config" | "copilot-instruction";
  exists: boolean;
}

export interface AgentAdapter {
  id: string;
  displayName: string;

  discoverProjectResources(
    discovery: DiscoveryResult,
  ): DiscoveredAgentResource[];

  detectInstallation(ctx: Context): Promise<AgentInstallationEvidence>;
}

export interface AgentDetectionRow {
  adapterId: string;
  displayName: string;
  configured: boolean;
  configuredResources: DiscoveredAgentResource[];
  installation: AgentInstallationEvidence;
}
