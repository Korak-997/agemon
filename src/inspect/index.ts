import { detectAgents } from "../adapters/detect.js";
import type { AgentDetectionRow } from "../adapters/types.js";
import type { Context } from "../core/context.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import { getRegisteredPlugins } from "../plugins/index.js";
import type { AgemonPlugin, CapabilityStateRow } from "../plugins/types.js";
import { renderInspectReport } from "../ui/inspect-view.js";
import { collectCapabilityStates } from "./capabilities.js";
import { type ClassifiedResource, classifyResources } from "./classify.js";
import { discoverRepository } from "./discover.js";
import { type DuplicationReport, detectDuplication } from "./duplication.js";
import { redactJsonValue } from "./redact.js";

export type StructuredConfigStatus =
  | "present"
  | "absent"
  | "invalid"
  | "excluded";

export interface RedactedStructuredConfig {
  path: string;
  status: StructuredConfigStatus;
  redacted: unknown;
  redactedPaths: string[];
  detail: string | null;
}

export interface InspectReport {
  isolation: { status: string; trackedAgemonPaths: string[] };
  resources: ClassifiedResource[];
  capabilities: CapabilityStateRow[];
  structuredConfig: RedactedStructuredConfig[];
  binaries: { name: string; present: boolean }[];
  duplication: DuplicationReport;
  agents: AgentDetectionRow[];
}

export interface InspectOptions {
  checkAgentsUsable?: boolean;
}

export async function inspectRepository(
  ctx: Context,
  plugins: AgemonPlugin[] = getRegisteredPlugins(),
  options: InspectOptions = {},
): Promise<InspectReport> {
  const discovery = await discoverRepository(ctx);
  const agents = await detectAgents(ctx, discovery, {
    checkUsable: options.checkAgentsUsable,
  });
  const resources = classifyResources(
    discovery,
    ctx.manifest.getActions(),
    (resourceId) => resolveCurrentDesiredRevision(plugins, ctx, resourceId),
  );
  const capabilities = await collectCapabilityStates(ctx, plugins);

  const structuredConfig: RedactedStructuredConfig[] =
    discovery.structuredConfigs.map((resource) => {
      if (resource.denylisted) {
        return {
          path: resource.path,
          status: "excluded",
          redacted: null,
          redactedPaths: [],
          detail: "private local config",
        };
      }
      if (!resource.exists) {
        return {
          path: resource.path,
          status: "absent",
          redacted: null,
          redactedPaths: [],
          detail: null,
        };
      }
      if (resource.parseError !== null) {
        return {
          path: resource.path,
          status: "invalid",
          redacted: null,
          redactedPaths: [],
          detail: resource.parseError,
        };
      }
      const { value, redactedPaths } = redactJsonValue(resource.parsed);
      return {
        path: resource.path,
        status: "present",
        redacted: value,
        redactedPaths,
        detail: null,
      };
    });

  const duplication = detectDuplication(
    discovery.ruleFiles.map((file) => ({
      path: file.path,
      contents: file.contents,
    })),
  );

  return {
    isolation: {
      status: discovery.isolation.status,
      trackedAgemonPaths: discovery.isolation.trackedAgemonPaths,
    },
    resources,
    capabilities,
    structuredConfig,
    binaries: discovery.binaries.map((binary) => ({
      name: binary.name,
      present: binary.present,
    })),
    duplication,
    agents,
  };
}

export async function runInspect(
  ctx: Context,
  options: { json: boolean; checkAgentsUsable?: boolean },
): Promise<void> {
  const report = await inspectRepository(ctx, undefined, {
    checkAgentsUsable: options.checkAgentsUsable,
  });

  if (options.json) {
    ctx.log.log(JSON.stringify(report, null, 2));
    return;
  }

  ctx.log.log(renderInspectReport(report));
}
