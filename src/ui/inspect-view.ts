import type { ClassifiedResource, ResourceState } from "../inspect/classify.js";
import { describeOverlap } from "../inspect/duplication.js";
import type { InspectReport } from "../inspect/index.js";
import type { CapabilityState } from "../plugins/types.js";
import { badge, section } from "./format.js";
import { renderTable } from "./table.js";
import { theme } from "./theme.js";

const RESOURCE_STATE_TONE: Record<ResourceState, Parameters<typeof badge>[1]> =
  {
    absent: "neutral",
    equivalent: "ok",
    "managed-current": "ok",
    "managed-drifted": "warn",
    mergeable: "warn",
    conflict: "danger",
    unmanaged: "neutral",
    invalid: "danger",
  };

const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  "present-managed": "present · managed",
  "present-adopted": "present · adopted",
  absent: "absent",
  unknown: "unknown",
};

const CAPABILITY_STATE_TONE: Record<
  CapabilityState,
  Parameters<typeof badge>[1]
> = {
  "present-managed": "ok",
  "present-adopted": "warn",
  absent: "neutral",
  unknown: "warn",
};

function resourceRow(resource: ClassifiedResource): string[] {
  return [
    resource.path,
    badge(resource.state, RESOURCE_STATE_TONE[resource.state]),
    resource.detail ?? "",
  ];
}

export function renderInspectReport(report: InspectReport): string {
  const blocks: string[] = [];

  blocks.push(section("Workspace isolation").trimStart());
  blocks.push(`  .agemon/ gitignore status: ${report.isolation.status}`);
  if (report.isolation.trackedAgemonPaths.length > 0) {
    blocks.push(
      `  ${theme.warn(
        `tracked .agemon/ paths: ${report.isolation.trackedAgemonPaths.join(", ")}`,
      )}`,
    );
  }

  blocks.push(section("Resources"));
  blocks.push(
    renderTable([
      ["RESOURCE", "STATE", "DETAIL"],
      ...report.resources.map(resourceRow),
    ]),
  );

  blocks.push(section("Capabilities"));
  if (report.capabilities.length === 0) {
    blocks.push("  no capability reports state in this repo");
  } else {
    blocks.push(
      renderTable([
        ["CAPABILITY", "RESOURCE", "STATE", "DETAIL"],
        ...report.capabilities.map((row) => [
          row.capabilityId,
          row.resourceId,
          badge(
            CAPABILITY_STATE_LABEL[row.state],
            CAPABILITY_STATE_TONE[row.state],
          ),
          row.detail ?? "",
        ]),
      ]),
    );
  }

  blocks.push(section("Structured config"));
  blocks.push(
    renderTable([
      ["FILE", "STATUS", "REDACTED"],
      ...report.structuredConfig.map((config) => [
        config.path,
        config.status,
        String(config.redactedPaths.length),
      ]),
    ]),
  );

  blocks.push(section("Machine capabilities"));
  blocks.push(
    renderTable([
      ["BINARY", "PRESENT"],
      ...report.binaries.map((binary) => [
        binary.name,
        binary.present ? "yes" : "no",
      ]),
    ]),
  );

  blocks.push(section("Duplication"));
  if (report.duplication.overlaps.length === 0) {
    blocks.push("  no overlapping instruction content detected");
  } else {
    blocks.push(
      ...report.duplication.overlaps.map(
        (overlap) => `  ${describeOverlap(overlap)}`,
      ),
    );
  }

  return blocks.join("\n");
}
