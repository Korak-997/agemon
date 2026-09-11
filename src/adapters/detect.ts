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

export interface DetectAgentsOptions {
  checkUsable?: boolean;
}

type BaseDetectionRow = Omit<AgentDetectionRow, "installation">;
export async function detectAgents(
  ctx: Context,
  discovery: DiscoveryResult,
  options: DetectAgentsOptions = {},
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

  if (!options.checkUsable) {
    return baseRows.map((row, index) => ({
      ...row,
      installation: installations[index],
    }));
  }

  const withUsability = await Promise.all(
    adapters.map((adapter, index) => {
      const installation = installations[index];
      return adapter.detectUsability
        ? adapter.detectUsability(ctx, installation)
        : installation;
    }),
  );
  return baseRows.map((row, index) => ({
    ...row,
    installation: withUsability[index],
  }));
}
