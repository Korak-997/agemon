import { describeOverlap } from "../inspect/duplication.js";
import type {
  CapabilityStatusRow,
  ManagedResourceStatus,
  StatusReport,
} from "../inspect/status.js";
import type { CapabilityState } from "../plugins/types.js";
import { badge, section } from "./format.js";
import { symbol } from "./symbols.js";
import { theme } from "./theme.js";

const CAPABILITY_STATE_TONE: Record<
  CapabilityState,
  Parameters<typeof badge>[1]
> = {
  "present-managed": "ok",
  "present-adopted": "warn",
  absent: "neutral",
  unknown: "warn",
};

const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  "present-managed": "present · managed",
  "present-adopted": "present · adopted",
  absent: "absent",
  unknown: "unknown",
};

function healthBadge(health: ManagedResourceStatus["health"]): string {
  if (health === "managed-current") {
    return badge("current", "ok");
  }
  if (health === "managed-drifted") {
    return badge("drifted", "warn");
  }
  return badge("missing", "danger");
}

function managedResourceLine(resource: ManagedResourceStatus): string {
  const detail = resource.detail ? `  ${theme.dim(resource.detail)}` : "";
  return `  ${resource.target.padEnd(20)} ${theme.dim(
    (resource.ownershipMode ?? "").padEnd(16),
  )} ${healthBadge(resource.health)}${detail}`;
}

function capabilityLine(row: CapabilityStatusRow): string {
  const state = `${badge(
    CAPABILITY_STATE_LABEL[row.state],
    CAPABILITY_STATE_TONE[row.state],
  )}`;
  const health =
    row.health === null
      ? ""
      : row.health.ok
        ? `  ${badge("healthy", "ok")}`
        : `  ${badge("unhealthy", "danger")} ${theme.dim(row.health.detail)}`;
  const detail =
    row.health !== null && !row.health.ok
      ? ""
      : row.detail
        ? `  ${theme.dim(row.detail)}`
        : "";
  return `  ${row.capabilityId.padEnd(18)} ${state}${health}${detail}`;
}

export function renderStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  lines.push(section("Environment").trimStart());
  lines.push(
    report.healthy
      ? `  ${theme.ok(`${symbol("ok")} Environment healthy`)} — every managed resource matches agemon's ledger.`
      : `  ${theme.warn(`${symbol("warn")} Environment needs attention`)} — see the flagged rows below.`,
  );

  lines.push(section("Managed resources"));
  if (report.managedResources.length === 0) {
    lines.push("  none recorded in the ledger yet");
  } else {
    lines.push(...report.managedResources.map(managedResourceLine));
  }

  lines.push(section("Capabilities"));
  if (report.capabilities.length === 0) {
    lines.push("  no capability reports state in this repo");
  } else {
    lines.push(...report.capabilities.map(capabilityLine));
  }

  lines.push(section("Duplication"));
  if (report.duplication.length === 0) {
    lines.push("  no overlapping instruction content detected");
  } else {
    lines.push(
      ...report.duplication.map((overlap) => `  ${describeOverlap(overlap)}`),
    );
  }

  lines.push(section("Workspace isolation"));
  if (report.trackedAgemonPaths.length === 0) {
    lines.push("  .agemon/ is not tracked by git");
  } else {
    lines.push(
      `  ${theme.warn(`${symbol("warn")} ${report.trackedAgemonPaths.length} .agemon/ path(s) are tracked by git`)}`,
      `  ${symbol("arrow")} git rm -r --cached .agemon`,
    );
  }

  return lines.join("\n");
}
