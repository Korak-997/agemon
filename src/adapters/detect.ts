import type { Context } from "../core/context.js";
import type { DiscoveryResult } from "../inspect/discover.js";
import { getRegisteredAdapters } from "./index.js";
import type { AgentDetectionRow, AgentInstallationEvidence } from "./types.js";

export const PROBE_AGENT_INSTALLATIONS_PROMPT =
  "May agemon look for AI coding agents installed on this machine? It runs only " +
  "--version-style probes. No repository content leaves your machine.";

function configuredOnlyEvidence(): AgentInstallationEvidence {
  return {
    level: "configured",
    executablePath: null,
    version: null,
    evidence: [],
  };
}

type BaseDetectionRow = Omit<AgentDetectionRow, "installation">;
export async function detectAgents(
  ctx: Context,
  discovery: DiscoveryResult,
): Promise<AgentDetectionRow[]> {
  const adapters = getRegisteredAdapters();
  const baseRows: BaseDetectionRow[] = adapters.map((adapter) => {
    const resources = adapter.discoverProjectResources(discovery);
    return {
      adapterId: adapter.id,
      displayName: adapter.displayName,
      configured: resources.some((resource) => resource.exists),
      configuredResources: resources,
    };
  });

  const canProbeInstallations = await ctx.confirm(
    PROBE_AGENT_INSTALLATIONS_PROMPT,
  );
  if (!canProbeInstallations) {
    return baseRows.map((row) => ({
      ...row,
      installation: configuredOnlyEvidence(),
    }));
  }

  const installations = await Promise.all(
    adapters.map((adapter) => adapter.detectInstallation(ctx)),
  );
  return baseRows.map((row, index) => ({
    ...row,
    installation: installations[index],
  }));
}
