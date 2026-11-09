import type { AgentDetectionRow } from "../adapters/types.js";
import { GITHUB_REPOSITORY } from "../core/github-release.js";
import { printable } from "../core/untrusted-text.js";
import type { ClassifiedResource, ResourceState } from "../inspect/classify.js";
import type { CloudReadiness } from "../inspect/cloud.js";
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
  "present-modified": "present · changed",
  absent: "absent",
  declined: "absent · declined",
  unknown: "unknown",
};

const CAPABILITY_STATE_TONE: Record<
  CapabilityState,
  Parameters<typeof badge>[1]
> = {
  "present-managed": "ok",
  "present-adopted": "warn",
  "present-modified": "warn",
  absent: "neutral",
  declined: "neutral",
  unknown: "warn",
};

function resourceRow(resource: ClassifiedResource): string[] {
  return [
    printable(resource.path),
    badge(resource.state, RESOURCE_STATE_TONE[resource.state]),
    printable(resource.detail ?? ""),
  ];
}

function agentStateLabel(row: AgentDetectionRow): string {
  const parts = [row.configured ? "configured" : "not configured"];
  if (row.installation.level !== "configured") {
    parts.push(row.installation.level);
  }
  return parts.join(", ");
}

function agentStateTone(row: AgentDetectionRow): Parameters<typeof badge>[1] {
  if (
    row.installation.level === "installed" ||
    row.installation.level === "usable"
  ) {
    return "ok";
  }
  return row.configured ? "warn" : "neutral";
}

function agentDetail(row: AgentDetectionRow): string {
  const { installation } = row;
  if (installation.executablePath) {
    return `${installation.executablePath}${
      installation.version ? `  v${installation.version}` : ""
    }`;
  }
  if (installation.evidence.length > 0) {
    return installation.evidence.join("; ");
  }
  return row.configured ? "not probed" : "";
}

function agentRow(row: AgentDetectionRow): string[] {
  return [
    row.displayName,
    badge(agentStateLabel(row), agentStateTone(row)),
    agentDetail(row),
  ];
}

function cloudReadinessLines(cloud: CloudReadiness): string[] {
  const lines: string[] = [];
  if (cloud.gitCheckError !== null) {
    lines.push(`  ${theme.warn(cloud.gitCheckError)}`);
  }
  if (cloud.uncommittedPaths.length > 0) {
    lines.push(
      `  ${theme.warn("not committed, so Claude Code on the web won't see it:")}`,
      ...cloud.uncommittedPaths.map((path) => `    ${printable(path)}`),
    );
  }
  if (cloud.ignoredPaths.length > 0) {
    lines.push(
      `  ${theme.warn("gitignored, so Claude Code on the web won't see it:")}`,
      ...cloud.ignoredPaths.map((path) => `    ${printable(path)}`),
    );
  }
  if (cloud.unpushedCommits !== null && cloud.unpushedCommits > 0) {
    lines.push(
      `  ${theme.warn(`${cloud.unpushedCommits} commit(s) changing agent config aren't pushed yet`)}`,
    );
  }
  if (cloud.setupScript !== null) {
    lines.push(
      `  ${theme.warn(`this config runs ${cloud.toolsToInstall.join(", ")}, which a cloud session doesn't have`)}`,
      "  paste this into the cloud environment's Setup script:",
      ...cloud.setupScript
        .trimEnd()
        .split("\n")
        .map((line) => `    ${line}`),
    );
  }
  if (lines.length === 0) {
    lines.push(
      "  nothing here stops Claude Code on the web from using this repo",
    );
  }
  lines.push(
    `  claude.ai chat: Customize > Plugins > Add > Add marketplace > ${GITHUB_REPOSITORY}`,
  );
  return lines;
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
  if (report.isolation.trackingCheckError !== null) {
    blocks.push(`  ${theme.warn(report.isolation.trackingCheckError)}`);
  }
  if (report.configError !== null) {
    blocks.push(`  ${theme.warn(report.configError)}`);
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
          printable(row.detail ?? ""),
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

  blocks.push(section("Agents"));
  blocks.push(
    renderTable([["AGENT", "STATE", "DETAIL"], ...report.agents.map(agentRow)]),
  );

  blocks.push(section("Claude on the web"));
  blocks.push(...cloudReadinessLines(report.cloud));

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
