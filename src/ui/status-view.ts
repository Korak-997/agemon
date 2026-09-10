import { describeOverlap } from "../inspect/duplication.js";
import type {
  CapabilityStatusRow,
  ManagedResourceStatus,
  StatusReport,
} from "../inspect/status.js";
import type { CapabilityState } from "../plugins/types.js";
import { box } from "./box.js";
import { badge, section } from "./format.js";
import { symbol } from "./symbols.js";
import { renderTable } from "./table.js";
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

function managedResourceRow(resource: ManagedResourceStatus): string[] {
  return [
    resource.target,
    resource.ownershipMode ?? "",
    healthBadge(resource.health),
    resource.detail ?? "",
  ];
}

function capabilityRow(row: CapabilityStatusRow): string[] {
  const state = badge(
    CAPABILITY_STATE_LABEL[row.state],
    CAPABILITY_STATE_TONE[row.state],
  );
  const health =
    row.health === null
      ? ""
      : row.health.ok
        ? badge("healthy", "ok")
        : badge("unhealthy", "danger");
  const detail =
    row.health !== null && !row.health.ok
      ? row.health.detail
      : (row.detail ?? "");
  return [row.capabilityId, state, health, detail];
}

export function renderStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  lines.push(section("Environment").trimStart());
  lines.push(
    report.healthy
      ? box({
          title: `${symbol("ok")} Environment healthy`,
          body: "every managed resource matches agemon's ledger",
          tone: "ok",
        })
      : box({
          title: `${symbol("warn")} Environment needs attention`,
          body: "see the flagged rows below",
          tone: "warn",
        }),
  );

  lines.push(section("Managed resources"));
  if (report.managedResources.length === 0) {
    lines.push("  none recorded in the ledger yet");
  } else {
    lines.push(
      renderTable([
        ["RESOURCE", "OWNERSHIP", "HEALTH", "DETAIL"],
        ...report.managedResources.map(managedResourceRow),
      ]),
    );
  }

  lines.push(section("Capabilities"));
  if (report.capabilities.length === 0) {
    lines.push("  no capability reports state in this repo");
  } else {
    lines.push(
      renderTable([
        ["CAPABILITY", "STATE", "HEALTH", "DETAIL"],
        ...report.capabilities.map(capabilityRow),
      ]),
    );
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
