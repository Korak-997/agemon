import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../core/context.js";
import { fingerprintContent } from "../core/fingerprint.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import type { AgemonPlugin, CapabilityStateRow } from "../plugins/types.js";
import { renderTable } from "../ui/table.js";
import { collectCapabilityStates } from "./capabilities.js";
import { TEMPLATE_DRIFT_DETAIL, USER_DRIFT_DETAIL } from "./classify.js";
import { discoverRepository } from "./discover.js";
import {
  describeOverlap,
  detectDuplication,
  type OverlapFinding,
} from "./duplication.js";

const RULE_FILE_RESOURCE_PREFIX = "rule-file:";

const CAPABILITY_STATE_LABELS: Record<CapabilityStateRow["state"], string> = {
  "present-managed": "present (managed)",
  "present-adopted": "present (adopted)",
  absent: "absent",
  unknown: "unknown",
};

export type ManagedResourceHealth =
  | "managed-current"
  | "managed-drifted"
  | "missing";

export interface ManagedResourceStatus {
  resourceId: string;
  target: string;
  ownershipMode: string | null;
  health: ManagedResourceHealth;
  detail: string | null;
}

export interface CapabilityHealth {
  ok: boolean;
  detail: string;
}

export interface CapabilityStatusRow extends CapabilityStateRow {
  /**
   * A `verify()` verdict, present only when agemon has a ledger record for the
   * capability (so it is something agemon is expected to keep healthy).
   */
  health: CapabilityHealth | null;
}

export interface StatusReport {
  managedResources: ManagedResourceStatus[];
  capabilities: CapabilityStatusRow[];
  duplication: OverlapFinding[];
  trackedAgemonPaths: string[];
  healthy: boolean;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function isFileBackedRuleEntry(entry: LedgerEntry): entry is LedgerEntry & {
  resourceId: string;
  fingerprintAfter: string;
} {
  return (
    entry.fingerprintAfter !== null &&
    entry.resourceId?.startsWith(RULE_FILE_RESOURCE_PREFIX) === true
  );
}

export async function checkManagedResources(
  ctx: Context,
  plugins: AgemonPlugin[] = [],
): Promise<ManagedResourceStatus[]> {
  const seenResourceIds = new Set<string>();
  const results: ManagedResourceStatus[] = [];

  for (const entry of ctx.manifest.getActions()) {
    if (
      !isFileBackedRuleEntry(entry) ||
      seenResourceIds.has(entry.resourceId)
    ) {
      continue;
    }
    seenResourceIds.add(entry.resourceId);

    const contents = await readFileIfExists(join(ctx.cwd, entry.target));
    let health: ManagedResourceHealth;
    let detail: string | null = null;
    if (contents === null) {
      health = "missing";
    } else if (fingerprintContent(contents) !== entry.fingerprintAfter) {
      health = "managed-drifted";
      detail = USER_DRIFT_DETAIL;
    } else if (entry.desiredRevision !== null) {
      const currentRevision = resolveCurrentDesiredRevision(
        plugins,
        ctx,
        entry.resourceId,
      );
      if (
        currentRevision !== null &&
        currentRevision !== entry.desiredRevision
      ) {
        health = "managed-drifted";
        detail = TEMPLATE_DRIFT_DETAIL;
      } else {
        health = "managed-current";
      }
    } else {
      health = "managed-current";
    }

    results.push({
      resourceId: entry.resourceId,
      target: entry.target,
      ownershipMode: entry.ownershipMode,
      health,
      detail,
    });
  }

  return results;
}

export async function verifyManagedState(
  ctx: Context,
  plugins: AgemonPlugin[] = [],
): Promise<string[]> {
  const problems: string[] = [];

  for (const managed of await checkManagedResources(ctx, plugins)) {
    if (managed.health === "missing") {
      problems.push(
        `${managed.target} is recorded in the ledger but missing on disk`,
      );
    } else if (managed.health === "managed-drifted") {
      problems.push(
        managed.detail === TEMPLATE_DRIFT_DETAIL
          ? `${managed.target} is behind agemon's current template; re-run to refresh`
          : `${managed.target} no longer matches its ledger fingerprint`,
      );
    }
  }

  const discovery = await discoverRepository(ctx);
  const overlaps = detectDuplication(
    discovery.ruleFiles.map((file) => ({
      path: file.path,
      contents: file.contents,
    })),
  ).overlaps;
  for (const overlap of overlaps) {
    problems.push(
      `duplicate guidance across managed files: ${overlap.left} ~ ${overlap.right}`,
    );
  }

  if (discovery.isolation.trackedAgemonPaths.length > 0) {
    problems.push(
      `.agemon/ is tracked by git (${discovery.isolation.trackedAgemonPaths.length} path(s)); run 'git rm -r --cached .agemon'`,
    );
  }

  return problems;
}

export async function buildStatusReport(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<StatusReport> {
  const managedResources = await checkManagedResources(ctx, plugins);

  const discovery = await discoverRepository(ctx);
  const duplication = detectDuplication(
    discovery.ruleFiles.map((file) => ({
      path: file.path,
      contents: file.contents,
    })),
  ).overlaps;

  const capabilities = await buildCapabilityStatusRows(ctx, plugins);

  const trackedAgemonPaths = discovery.isolation.trackedAgemonPaths;
  const healthy =
    managedResources.every(
      (resource) => resource.health === "managed-current",
    ) &&
    duplication.length === 0 &&
    capabilities.every((row) => row.health === null || row.health.ok) &&
    trackedAgemonPaths.length === 0;

  return {
    managedResources,
    capabilities,
    duplication,
    trackedAgemonPaths,
    healthy,
  };
}

async function buildCapabilityStatusRows(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<CapabilityStatusRow[]> {
  const rows = await collectCapabilityStates(ctx, plugins);
  const recordedCapabilityIds = new Set(
    ctx.manifest.getActions().map((action) => action.plugin),
  );

  const healthByCapability = new Map<string, CapabilityHealth | null>();
  const resolveHealth = async (
    capabilityId: string,
  ): Promise<CapabilityHealth | null> => {
    const cached = healthByCapability.get(capabilityId);
    if (cached !== undefined) {
      return cached;
    }

    let health: CapabilityHealth | null = null;
    const plugin = plugins.find((entry) => entry.id === capabilityId);
    if (plugin && recordedCapabilityIds.has(capabilityId)) {
      const verification = await plugin.verify(ctx);
      health = {
        ok: verification.ok,
        detail:
          verification.detail ?? (verification.ok ? "healthy" : "unhealthy"),
      };
    }
    healthByCapability.set(capabilityId, health);
    return health;
  };

  const result: CapabilityStatusRow[] = [];
  for (const row of rows) {
    result.push({ ...row, health: await resolveHealth(row.capabilityId) });
  }
  return result;
}

export function renderStatusReport(report: StatusReport): string {
  const sections: string[] = [];

  sections.push(
    report.healthy
      ? "Environment healthy — every managed resource matches agemon's ledger."
      : "Environment needs attention — see the flagged rows below.",
  );
  sections.push("");

  sections.push("Managed resources");
  if (report.managedResources.length === 0) {
    sections.push("  none recorded in the ledger yet");
  } else {
    sections.push(
      renderTable([
        ["RESOURCE", "OWNERSHIP", "HEALTH", "DETAIL"],
        ...report.managedResources.map((resource) => [
          resource.target,
          resource.ownershipMode ?? "",
          resource.health,
          resource.detail ?? "",
        ]),
      ]),
    );
  }
  sections.push("");

  sections.push("Capabilities");
  if (report.capabilities.length === 0) {
    sections.push("  no capabilities report state in this repo");
  } else {
    sections.push(
      renderTable([
        ["CAPABILITY", "STATE", "HEALTH", "DETAIL"],
        ...report.capabilities.map((row) => [
          row.capabilityId,
          CAPABILITY_STATE_LABELS[row.state],
          row.health === null ? "" : row.health.ok ? "ok" : "unhealthy",
          row.health !== null && !row.health.ok
            ? row.health.detail
            : (row.detail ?? ""),
        ]),
      ]),
    );
  }
  sections.push("");

  sections.push("Duplication");
  if (report.duplication.length === 0) {
    sections.push("  no overlapping instruction content detected");
  } else {
    for (const overlap of report.duplication) {
      sections.push(`  ${describeOverlap(overlap)}`);
    }
  }
  sections.push("");

  sections.push("Workspace isolation");
  if (report.trackedAgemonPaths.length === 0) {
    sections.push("  .agemon/ is not tracked by git");
  } else {
    sections.push(
      `  ${report.trackedAgemonPaths.length} .agemon/ path(s) are tracked by git`,
    );
    sections.push("  fix: git rm -r --cached .agemon");
  }

  return sections.join("\n");
}

export async function runStatus(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<void> {
  const report = await buildStatusReport(ctx, plugins);
  ctx.log.log(renderStatusReport(report));
}
