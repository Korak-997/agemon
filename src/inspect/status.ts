import { detectAgents } from "../adapters/detect.js";
import { readJournals } from "../core/apply-journal.js";
import type { Context } from "../core/context.js";
import { RefusedFileError, readRegularFileIfExists } from "../core/files.js";
import { fingerprintContent } from "../core/fingerprint.js";
import { resolveInsideRepo } from "../core/repo-paths.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import { printable } from "../core/untrusted-text.js";
import { resolveCurrentDesiredRevision } from "../plugins/desired-revision.js";
import {
  describeSharedTools,
  type SharedToolStatus,
} from "../plugins/shared-resource.js";
import type { AgemonPlugin, CapabilityStateRow } from "../plugins/types.js";
import { renderStatusReport } from "../ui/status-view.js";
import { collectCapabilityStates } from "./capabilities.js";
import { TEMPLATE_DRIFT_DETAIL, USER_DRIFT_DETAIL } from "./classify.js";
import { discoverRepository, ROOT_RULE_FILES } from "./discover.js";
import { detectDuplication, type OverlapFinding } from "./duplication.js";

const RULE_FILE_RESOURCE_PREFIX = "rule-file:";
const MANAGED_RULE_FILE_TARGETS: ReadonlySet<string> = new Set(ROOT_RULE_FILES);

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

export interface InterruptedApplySummary {
  planId: string;
  startedAt: string;
}

export interface StatusReport {
  managedResources: ManagedResourceStatus[];
  capabilities: CapabilityStatusRow[];
  sharedResources: SharedToolStatus[];
  duplication: OverlapFinding[];
  trackedAgemonPaths: string[];
  trackingCheckError: string | null;
  interruptedApply: InterruptedApplySummary | null;
  agentsSummary: AgentsSummary;
  healthy: boolean;
  hasAgemonState: boolean;
}

async function findInterruptedApply(
  ctx: Context,
): Promise<InterruptedApplySummary | null> {
  const [interrupted] = await readJournals(ctx.cwd);
  return interrupted
    ? {
        planId: printable(interrupted.journal.planId),
        startedAt: printable(interrupted.journal.startedAt),
      }
    : null;
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

type ManagedTargetRead =
  | { contents: string | null; refused: false }
  | { contents: null; refused: true };

async function readManagedTarget(
  ctx: Context,
  target: string,
): Promise<ManagedTargetRead> {
  try {
    return {
      contents: await readRegularFileIfExists(
        await resolveInsideRepo(ctx.cwd, target),
      ),
      refused: false,
    };
  } catch (error) {
    if (!(error instanceof RefusedFileError)) {
      throw error;
    }
    return { contents: null, refused: true };
  }
}

export async function checkManagedResources(
  ctx: Context,
  plugins: AgemonPlugin[] = [],
): Promise<ManagedResourceStatus[]> {
  const seenResourceIds = new Set<string>();
  const readsByTarget = new Map<string, Promise<ManagedTargetRead>>();
  const results: ManagedResourceStatus[] = [];

  for (const entry of ctx.manifest.getActions()) {
    if (
      !isFileBackedRuleEntry(entry) ||
      seenResourceIds.has(entry.resourceId)
    ) {
      continue;
    }
    seenResourceIds.add(entry.resourceId);
    const displayTarget = printable(entry.target);
    const reportDrift = (detail: string) =>
      results.push({
        resourceId: entry.resourceId,
        target: displayTarget,
        ownershipMode: entry.ownershipMode,
        health: "managed-drifted",
        detail,
      });

    if (!MANAGED_RULE_FILE_TARGETS.has(entry.target)) {
      reportDrift(
        `ignoring ledger entry for ${displayTarget}: master-prompt does not manage that file`,
      );
      continue;
    }

    let pendingRead = readsByTarget.get(entry.target);
    if (pendingRead === undefined) {
      pendingRead = readManagedTarget(ctx, entry.target);
      readsByTarget.set(entry.target, pendingRead);
    }
    const targetRead = await pendingRead;
    if (targetRead.refused) {
      reportDrift(USER_DRIFT_DETAIL);
      continue;
    }

    const { contents } = targetRead;
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
      target: displayTarget,
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
    } else if (managed.detail === TEMPLATE_DRIFT_DETAIL) {
      problems.push(
        `${managed.target} is behind agemon's current template; re-run to refresh`,
      );
    } else if (managed.detail === USER_DRIFT_DETAIL) {
      problems.push(
        `${managed.target} no longer matches its ledger fingerprint`,
      );
    } else if (managed.detail !== null) {
      problems.push(managed.detail);
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
  const sharedResources = await describeSharedTools(ctx, plugins);

  const agents = await detectAgents(ctx, discovery);
  const agentsSummary: AgentsSummary = {
    total: agents.length,
    configured: agents.filter((row) => row.configured).length,
    installed: agents.filter((row) => row.installation.level !== "configured")
      .length,
  };

  const trackedAgemonPaths = discovery.isolation.trackedAgemonPaths;
  const interruptedApply = await findInterruptedApply(ctx);
  const healthy =
    managedResources.every(
      (resource) => resource.health === "managed-current",
    ) &&
    duplication.length === 0 &&
    capabilities.every((row) => row.health === null || row.health.ok) &&
    trackedAgemonPaths.length === 0 &&
    interruptedApply === null;

  return {
    managedResources,
    capabilities,
    sharedResources,
    duplication,
    trackedAgemonPaths,
    trackingCheckError: discovery.isolation.trackingCheckError,
    interruptedApply,
    agentsSummary,
    healthy,
    hasAgemonState: ctx.manifest.hasActions() || interruptedApply !== null,
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
): Promise<StatusReport> {
  const report = await buildStatusReport(ctx, plugins);
  ctx.log.log(renderStatusReport(report));
  return report;
}
