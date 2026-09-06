import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../core/context.js";
import { fingerprintContent } from "../core/fingerprint.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import type { AgemonPlugin } from "../plugins/types.js";
import { renderTable } from "../ui/table.js";
import { TEMPLATE_DRIFT_DETAIL, USER_DRIFT_DETAIL } from "./classify.js";
import { discoverRepository } from "./discover.js";
import { detectDuplication, type OverlapFinding } from "./duplication.js";

const DAEMON_CAPABILITY_ID = "daemon";
const RULE_FILE_RESOURCE_PREFIX = "rule-file:";

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

export interface DaemonStatus {
  ok: boolean;
  detail: string;
}

export interface StatusReport {
  managedResources: ManagedResourceStatus[];
  duplication: OverlapFinding[];
  daemon: DaemonStatus | null;
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
  ).overlaps.filter(
    (overlap) => overlap.left === "AGENTS.md" || overlap.right === "AGENTS.md",
  );
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
  const managedPaths = new Set(
    managedResources.map((resource) => resource.target),
  );

  const discovery = await discoverRepository(ctx);
  const duplication = detectDuplication(
    discovery.ruleFiles.map((file) => ({
      path: file.path,
      contents: file.contents,
    })),
  ).overlaps.filter(
    (overlap) =>
      !(managedPaths.has(overlap.left) && managedPaths.has(overlap.right)),
  );

  const daemonRecorded = ctx.manifest
    .getActions()
    .some((action) => action.plugin === DAEMON_CAPABILITY_ID);
  const daemonPlugin = plugins.find(
    (plugin) => plugin.id === DAEMON_CAPABILITY_ID,
  );
  let daemon: DaemonStatus | null = null;
  if (daemonRecorded && daemonPlugin) {
    const verification = await daemonPlugin.verify(ctx);
    daemon = {
      ok: verification.ok,
      detail:
        verification.detail ?? (verification.ok ? "active" : "not active"),
    };
  }

  const trackedAgemonPaths = discovery.isolation.trackedAgemonPaths;
  const healthy =
    managedResources.every(
      (resource) => resource.health === "managed-current",
    ) &&
    duplication.length === 0 &&
    (daemon === null || daemon.ok) &&
    trackedAgemonPaths.length === 0;

  return { managedResources, duplication, daemon, trackedAgemonPaths, healthy };
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

  sections.push("Daemon");
  if (report.daemon === null) {
    sections.push("  not managed by agemon in this repo");
  } else {
    sections.push(
      `  ${report.daemon.ok ? "ok" : "unhealthy"} — ${report.daemon.detail}`,
    );
  }
  sections.push("");

  sections.push("Duplication");
  if (report.duplication.length === 0) {
    sections.push("  no unmanaged duplicate instruction content detected");
  } else {
    for (const overlap of report.duplication) {
      sections.push(
        `  ${overlap.left} ~ ${overlap.right} (similarity ${overlap.similarity})`,
      );
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
