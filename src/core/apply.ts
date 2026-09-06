import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IsolationStatus } from "../inspect/discover.js";
import type { AgemonPlugin, ProposedOperation } from "../plugins/types.js";
import { writeImmutableBackup } from "./backups.js";
import type { Context } from "./context.js";
import { fingerprintContent } from "./fingerprint.js";
import { writeAgemonGitignoreEntry } from "./gitignore.js";
import { type Plan, writePlan } from "./plan-store.js";

const FILE_TARGETING_ACTIONS: ReadonlySet<ProposedOperation["action"]> =
  new Set(["create", "replace", "merge-block", "merge-key", "adopt"]);

export interface ApplyPlanInput {
  plan: Plan;
  approved: ProposedOperation[];
  workspaceIsolationApproved: boolean | null;
  isolationStatus: IsolationStatus;
  allowUnignoredState: boolean;
}

export interface ApplyPlanResult {
  applied: ProposedOperation[];
}

interface FileRollbackSnapshot {
  targetPath: string;
  previousContents: string | null;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function fileTargetingOperations(
  operations: ProposedOperation[],
): ProposedOperation[] {
  return operations.filter((operation) =>
    FILE_TARGETING_ACTIONS.has(operation.action),
  );
}

async function enforceWorkspaceIsolation(
  ctx: Context,
  input: ApplyPlanInput,
): Promise<void> {
  if (input.isolationStatus === "ignored") {
    return;
  }
  if (input.allowUnignoredState) {
    ctx.ui.info(
      "Writing .agemon/ state without a .gitignore entry (--allow-unignored-state).",
    );
    return;
  }
  if (input.workspaceIsolationApproved === true) {
    await writeAgemonGitignoreEntry(ctx.cwd);
    return;
  }
  throw new Error(
    "Refusing to write .agemon/ state: /.agemon/ is not git-ignored. Re-run " +
      "interactively (or with --yes) so agemon can add it, or pass " +
      "--allow-unignored-state to override.",
  );
}

async function assertPlanIsFresh(
  ctx: Context,
  planId: string,
  operations: ProposedOperation[],
): Promise<void> {
  for (const operation of fileTargetingOperations(operations)) {
    const currentContents = await readFileIfExists(
      join(ctx.cwd, operation.targetPath),
    );
    const actualFingerprint =
      currentContents === null ? null : fingerprintContent(currentContents);
    if (actualFingerprint !== operation.expectedFingerprint) {
      throw new Error(
        `Plan ${planId} is stale: ${operation.targetPath} changed since it was planned. Re-run 'agemon plan'.`,
      );
    }
  }
}

async function captureRollbackSnapshots(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<FileRollbackSnapshot[]> {
  const snapshots: FileRollbackSnapshot[] = [];
  for (const operation of fileTargetingOperations(operations)) {
    const previousContents = await readFileIfExists(
      join(ctx.cwd, operation.targetPath),
    );
    snapshots.push({ targetPath: operation.targetPath, previousContents });
    if (previousContents !== null) {
      await writeImmutableBackup(
        ctx.cwd,
        operation.resourceId,
        previousContents,
      );
    }
  }
  return snapshots;
}

async function restoreRollbackSnapshots(
  ctx: Context,
  snapshots: FileRollbackSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const absolutePath = join(ctx.cwd, snapshot.targetPath);
    if (snapshot.previousContents === null) {
      await rm(absolutePath, { force: true });
    } else {
      await writeFile(absolutePath, snapshot.previousContents, "utf8");
    }
  }
}

function groupApprovedByCapability(
  plan: Plan,
  approved: ProposedOperation[],
): Map<string, ProposedOperation[]> {
  const approvedIds = new Set(approved.map((operation) => operation.id));
  const grouped = new Map<string, ProposedOperation[]>();
  for (const operation of plan.operations) {
    if (!approvedIds.has(operation.id)) {
      continue;
    }
    const bucket = grouped.get(operation.capabilityId);
    if (bucket) {
      bucket.push(operation);
    } else {
      grouped.set(operation.capabilityId, [operation]);
    }
  }
  return grouped;
}

async function runCapabilityWork(
  ctx: Context,
  plugin: AgemonPlugin,
  operations: ProposedOperation[],
): Promise<void> {
  if (plugin.apply) {
    await plugin.apply(ctx, operations);
  } else {
    const presence = await plugin.detect(ctx);
    if (presence.present) {
      ctx.ui.info(`${plugin.id} already present — nothing to install`);
    } else {
      await plugin.install(ctx);
    }
  }

  const verification = await plugin.verify(ctx);
  if (!verification.ok) {
    throw new Error(
      verification.detail ??
        `Verification failed for '${plugin.id}' after apply.`,
    );
  }
}

export async function applyPlan(
  ctx: Context,
  allPlugins: AgemonPlugin[],
  input: ApplyPlanInput,
): Promise<ApplyPlanResult> {
  const pluginById = new Map(
    allPlugins.map((plugin) => [plugin.id, plugin] as const),
  );
  const approvedByCapability = groupApprovedByCapability(
    input.plan,
    input.approved,
  );

  await enforceWorkspaceIsolation(ctx, input);
  await writePlan(ctx.cwd, input.plan);
  await assertPlanIsFresh(ctx, input.plan.id, input.approved);

  const rollbackSnapshots = await captureRollbackSnapshots(ctx, input.approved);
  const ledgerActionIdsBeforeRun = new Set(
    ctx.manifest.getActions().map((action) => action.id),
  );

  const applied: ProposedOperation[] = [];
  try {
    for (const [capabilityId, operations] of approvedByCapability) {
      const plugin = pluginById.get(capabilityId);
      if (!plugin) {
        throw new Error(
          `Plan references capability '${capabilityId}', which is not registered.`,
        );
      }
      await runCapabilityWork(ctx, plugin, operations);
      applied.push(...operations);
    }
  } catch (error) {
    await restoreRollbackSnapshots(ctx, rollbackSnapshots);
    await ctx.manifest.removeActionsAddedSince(ledgerActionIdsBeforeRun);
    ctx.ui.fail(
      `apply rolled back — repo left as it started (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    throw error;
  }

  return { applied };
}
