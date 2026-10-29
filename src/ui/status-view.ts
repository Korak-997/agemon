import { printable } from "../core/untrusted-text.js";
import { describeOverlap } from "../inspect/duplication.js";
import type {
  CapabilityStatusRow,
  ManagedResourceStatus,
  StatusReport,
} from "../inspect/status.js";
import type { SharedToolStatus } from "../plugins/shared-resource.js";
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
  declined: "neutral",
  unknown: "warn",
};

const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  "present-managed": "present · managed",
  "present-adopted": "present · adopted",
  absent: "absent",
  declined: "absent · declined",
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

function describeSharedToolHolder(
  holder: SharedToolStatus["holders"][number],
): string {
  const path = printable(holder.path);
  if (holder.missing) {
    return `${path} (missing — dropped on the next change)`;
  }
  return holder.thisRepository ? `${path} (this repository)` : path;
}

function describeSharedToolNote(tool: SharedToolStatus): string {
  if (tool.heldWithoutLedgerEntry) {
    return "held by this repository but not in its ledger — run 'agemon' to repair";
  }
  if (tool.origin === "installed") {
    return `installed by ${printable(tool.recordedBy ?? "")}`;
  }
  if (tool.origin === "migrated") {
    return `installed before agemon tracked shared tools (per ${printable(tool.recordedBy ?? "")}); 'agemon nuke --remove-shared ${tool.tool}' there, or '${tool.manualRemoveCommand}'`;
  }
  return `there before agemon tracked it; agemon never removes it ('${tool.manualRemoveCommand}')`;
}

function sharedToolLines(tool: SharedToolStatus): string[] {
  return [
    `  ${tool.tool} (${tool.origin}) — ${describeSharedToolNote(tool)}`,
    `    used by: ${tool.holders.map(describeSharedToolHolder).join(", ") || "nobody"}`,
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
      : !row.health.ok
        ? badge("unhealthy", "danger")
        : row.health.attention !== null
          ? badge("needs attention", "warn")
          : badge("healthy", "ok");
  const detail =
    row.health === null
      ? (row.detail ?? "")
      : !row.health.ok
        ? row.health.detail
        : (row.detail ?? "");
  return [row.capabilityId, state, health, detail];
}

export function renderStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  lines.push(section("Environment").trimStart());
  if (report.interruptedApply !== null) {
    lines.push(
      box({
        title: `${symbol("warn")} Interrupted apply`,
        body: `An earlier apply (plan ${report.interruptedApply.planId}, started ${report.interruptedApply.startedAt}) was interrupted — run 'agemon recover'.`,
        tone: "warn",
      }),
    );
  }
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
    const attentionNotes = new Set(
      report.capabilities.flatMap((row) =>
        row.health?.attention
          ? [`  ${row.capabilityId}: ${printable(row.health.attention)}`]
          : [],
      ),
    );
    lines.push(...attentionNotes);
  }

  lines.push(section("Shared tools"));
  if (report.sharedResources.length === 0) {
    lines.push("  none recorded on this machine");
  } else {
    lines.push(...report.sharedResources.flatMap(sharedToolLines));
  }

  lines.push(section("Duplication"));
  if (report.duplication.length === 0) {
    lines.push("  no overlapping instruction content detected");
  } else {
    lines.push(
      ...report.duplication.map((overlap) => `  ${describeOverlap(overlap)}`),
    );
  }

  lines.push(section("Agents"));
  lines.push(
    `  ${report.agentsSummary.configured}/${report.agentsSummary.total} configured, ${report.agentsSummary.installed}/${report.agentsSummary.total} installed`,
  );

  if (report.configError !== null) {
    lines.push(section("Configuration"));
    lines.push(`  ${theme.warn(`${symbol("warn")} ${report.configError}`)}`);
  }

  lines.push(section("Workspace isolation"));
  if (report.trackingCheckError !== null) {
    lines.push(
      `  ${theme.warn(`${symbol("warn")} ${report.trackingCheckError}`)}`,
    );
  } else if (report.trackedAgemonPaths.length === 0) {
    lines.push("  .agemon/ is not tracked by git");
  } else {
    lines.push(
      `  ${theme.warn(`${symbol("warn")} ${report.trackedAgemonPaths.length} .agemon/ path(s) are tracked by git`)}`,
      `  ${symbol("arrow")} git rm -r --cached .agemon`,
    );
  }

  return lines.join("\n");
}
