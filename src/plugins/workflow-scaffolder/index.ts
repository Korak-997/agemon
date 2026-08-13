import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../core/context.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../types.js";
import { WORKFLOW_BUNDLE, type WorkflowBundleEntry } from "./catalog.js";

const PLUGIN_ID = "workflow-scaffolder";
const WORKFLOW_DIRECTORY = ".github/workflows";
const ACTION_TYPE_SCAFFOLDED_WORKFLOW = "scaffolded-workflow";

function getPluginActions(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.plugin === PLUGIN_ID);
}

function buildWorkflowPath(cwd: string, entry: WorkflowBundleEntry): string {
  return join(cwd, WORKFLOW_DIRECTORY, entry.filename);
}

function buildWorkflowTarget(entry: WorkflowBundleEntry): string {
  return `${WORKFLOW_DIRECTORY}/${entry.filename}`;
}

function hasManagedWorkflowRecord(
  ctx: Context,
  workflowTarget: string,
): boolean {
  return getPluginActions(ctx).some(
    (action) =>
      action.type === ACTION_TYPE_SCAFFOLDED_WORKFLOW &&
      action.target === workflowTarget &&
      action.preExisting === false,
  );
}

function getUnmanagedCollisions(ctx: Context): string[] {
  const collisions: string[] = [];
  for (const entry of WORKFLOW_BUNDLE) {
    const workflowPath = buildWorkflowPath(ctx.cwd, entry);
    const workflowTarget = buildWorkflowTarget(entry);
    if (!existsSync(workflowPath)) {
      continue;
    }
    if (hasManagedWorkflowRecord(ctx, workflowTarget)) {
      continue;
    }
    collisions.push(workflowTarget);
  }
  return collisions;
}

function assertNoUnmanagedCollisions(ctx: Context): void {
  const collisions = getUnmanagedCollisions(ctx);
  if (collisions.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to overwrite pre-existing workflow file(s): ${collisions.join(", ")}`,
  );
}

function allBundleWorkflowsExist(ctx: Context): boolean {
  return WORKFLOW_BUNDLE.every((entry) =>
    existsSync(buildWorkflowPath(ctx.cwd, entry)),
  );
}

async function detectWorkflows(ctx: Context): Promise<PluginPresence> {
  assertNoUnmanagedCollisions(ctx);

  if (!allBundleWorkflowsExist(ctx)) {
    return { present: false, preExisting: false };
  }

  return { present: true, preExisting: false };
}

async function installWorkflows(ctx: Context): Promise<void> {
  assertNoUnmanagedCollisions(ctx);

  if (ctx.dryRun) {
    for (const entry of WORKFLOW_BUNDLE) {
      ctx.ui.info(`Would scaffold workflow ${buildWorkflowTarget(entry)}`);
    }
    return;
  }

  const workflowDirectoryPath = join(ctx.cwd, WORKFLOW_DIRECTORY);
  await mkdir(workflowDirectoryPath, { recursive: true });

  for (const entry of WORKFLOW_BUNDLE) {
    const workflowPath = buildWorkflowPath(ctx.cwd, entry);
    const workflowTarget = buildWorkflowTarget(entry);

    await writeFile(workflowPath, entry.contents, "utf8");

    if (!hasManagedWorkflowRecord(ctx, workflowTarget)) {
      await ctx.manifest.recordAction({
        plugin: PLUGIN_ID,
        type: ACTION_TYPE_SCAFFOLDED_WORKFLOW,
        target: workflowTarget,
        preExisting: false,
      });
    }
  }
}

async function verifyWorkflows(
  ctx: Context,
): Promise<PluginVerificationResult> {
  if (ctx.dryRun) {
    return { ok: true, detail: "dry-run" };
  }

  const missingWorkflows = WORKFLOW_BUNDLE.map((entry) =>
    buildWorkflowTarget(entry),
  ).filter((workflowTarget) => !existsSync(join(ctx.cwd, workflowTarget)));

  if (missingWorkflows.length > 0) {
    return {
      ok: false,
      detail: `Missing workflow file(s): ${missingWorkflows.join(", ")}`,
    };
  }

  return {
    ok: true,
    detail: `${WORKFLOW_BUNDLE.length} workflow bundle entries present`,
  };
}

async function uninstallWorkflows(ctx: Context): Promise<void> {
  const managedActions = getPluginActions(ctx).filter(
    (action) =>
      action.type === ACTION_TYPE_SCAFFOLDED_WORKFLOW &&
      action.preExisting === false,
  );

  if (ctx.dryRun) {
    if (managedActions.length === 0) {
      ctx.ui.info("Would keep pre-existing workflow files untouched");
      return;
    }
    for (const action of managedActions) {
      ctx.ui.info(`Would remove workflow ${action.target}`);
    }
    return;
  }

  for (const action of managedActions) {
    await rm(join(ctx.cwd, action.target), { force: true });
  }

  await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
}

export const workflowScaffolderPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  detect: detectWorkflows,
  install: installWorkflows,
  verify: verifyWorkflows,
  uninstall: uninstallWorkflows,
};
