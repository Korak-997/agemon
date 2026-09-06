import type { Context } from "../core/context.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import { getRegisteredPlugins } from "../plugins/index.js";
import type { AgemonPlugin } from "../plugins/types.js";
import { renderTable } from "../ui/table.js";
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
  structuredConfig: RedactedStructuredConfig[];
  binaries: { name: string; present: boolean }[];
  duplication: DuplicationReport;
}

export async function inspectRepository(
  ctx: Context,
  plugins: AgemonPlugin[] = getRegisteredPlugins(),
): Promise<InspectReport> {
  const discovery = await discoverRepository(ctx);
  const resources = classifyResources(
    discovery,
    ctx.manifest.getActions(),
    (resourceId) => resolveCurrentDesiredRevision(plugins, ctx, resourceId),
  );

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
    structuredConfig,
    binaries: discovery.binaries.map((binary) => ({
      name: binary.name,
      present: binary.present,
    })),
    duplication,
  };
}

function renderInspectReport(report: InspectReport): string {
  const sections: string[] = [];

  sections.push("Workspace isolation");
  sections.push(`  .agemon/ gitignore status: ${report.isolation.status}`);
  if (report.isolation.trackedAgemonPaths.length > 0) {
    sections.push(
      `  tracked .agemon/ paths: ${report.isolation.trackedAgemonPaths.join(", ")}`,
    );
  }
  sections.push("");

  sections.push("Resources");
  sections.push(
    renderTable([
      ["RESOURCE", "STATE", "DETAIL"],
      ...report.resources.map((resource) => [
        resource.path,
        resource.state,
        resource.detail ?? "",
      ]),
    ]),
  );
  sections.push("");

  sections.push("Structured config");
  sections.push(
    renderTable([
      ["FILE", "STATUS", "REDACTED VALUES"],
      ...report.structuredConfig.map((config) => [
        config.path,
        config.status,
        String(config.redactedPaths.length),
      ]),
    ]),
  );
  sections.push("");

  sections.push("Machine capabilities");
  sections.push(
    renderTable([
      ["BINARY", "PRESENT"],
      ...report.binaries.map((binary) => [
        binary.name,
        binary.present ? "yes" : "no",
      ]),
    ]),
  );
  sections.push("");

  sections.push("Duplication");
  if (report.duplication.overlaps.length === 0) {
    sections.push("  no overlapping instruction content detected");
  } else {
    for (const overlap of report.duplication.overlaps) {
      sections.push(
        `  ${overlap.left} ~ ${overlap.right} (similarity ${overlap.similarity})`,
      );
    }
  }

  return sections.join("\n");
}

export async function runInspect(
  ctx: Context,
  options: { json: boolean },
): Promise<void> {
  const report = await inspectRepository(ctx);

  if (options.json) {
    ctx.log.log(JSON.stringify(report, null, 2));
    return;
  }

  ctx.log.log(renderInspectReport(report));
}
