import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectAgents } from "../adapters/detect.js";
import type { Context } from "../core/context.js";
import { fingerprintContent } from "../core/fingerprint.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import type { AgemonPlugin, CapabilityStateRow } from "../plugins/types.js";
import { renderStatusReport } from "../ui/status-view.js";
import { collectCapabilityStates } from "./capabilities.js";
import { TEMPLATE_DRIFT_DETAIL, USER_DRIFT_DETAIL } from "./classify.js";
import { discoverRepository } from "./discover.js";
import { detectDuplication, type OverlapFinding } from "./duplication.js";

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

export interface CapabilityHealth {
  ok: boolean;
  detail: string;
}

export interface CapabilityStatusRow extends CapabilityStateRow {
  health: CapabilityHealth | null;
}

export interface AgentsSummary {
  total: number;
  configured: number;
  installed: number;
}

export interface StatusReport {
  managedResources: ManagedResourceStatus[];
  capabilities: CapabilityStatusRow[];
  duplication: OverlapFinding[];
  trackedAgemonPaths: string[];
  agentsSummary: AgentsSummary;
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

  const agents = await detectAgents(ctx, discovery);
  const agentsSummary: AgentsSummary = {
    total: agents.length,
    configured: agents.filter((row) => row.configured).length,
    installed: agents.filter((row) => row.installation.level !== "configured")
      .length,
  };

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
    agentsSummary,
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

export async function runStatus(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<void> {
  const report = await buildStatusReport(ctx, plugins);
  ctx.log.log(renderStatusReport(report));
}
