import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProposedOperation } from "../plugins/types.js";
import { fingerprintJson } from "./fingerprint.js";

const PLANS_DIRECTORY = ".agemon/plans";
const PLAN_ID_LENGTH = 16;

export interface Plan {
  id: string;
  agemonVersion: string;
  desiredStateHash: string;
  createdAt: string;
  operations: ProposedOperation[];
}

interface PlanIdentityInput {
  agemonVersion: string;
  desiredStateHash: string;
  operations: ProposedOperation[];
}

export function resolveDesiredStateHash(input: {
  capabilityIds: string[];
  skillGroups: string | null;
}): string {
  return fingerprintJson(input);
}

export function computePlanId(input: PlanIdentityInput): string {
  return fingerprintJson({
    agemonVersion: input.agemonVersion,
    desiredStateHash: input.desiredStateHash,
    operations: input.operations,
  }).slice(0, PLAN_ID_LENGTH);
}

export function resolvePlanPath(cwd: string, planId: string): string {
  return join(cwd, PLANS_DIRECTORY, `${planId}.json`);
}

export async function writePlan(cwd: string, plan: Plan): Promise<string> {
  const planPath = resolvePlanPath(cwd, plan.id);
  const payload = `${JSON.stringify(plan, null, 2)}\n`;
  const tempPath = `${planPath}.tmp-${process.pid}-${Date.now()}`;

  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, planPath);
  return planPath;
}

export async function readPlan(cwd: string, planId: string): Promise<Plan> {
  const contents = await readFile(resolvePlanPath(cwd, planId), "utf8");
  return JSON.parse(contents) as Plan;
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = [`Plan ${plan.id} (agemon ${plan.agemonVersion})`];

  if (plan.operations.length === 0) {
    lines.push("  nothing to do — desired state already reached");
    return lines.join("\n");
  }

  lines.push(`  ${plan.operations.length} proposed operation(s):`);
  for (const operation of plan.operations) {
    const targetLabel = operation.targetPath || operation.resourceId;
    lines.push("");
    lines.push(
      `  • ${operation.action} ${targetLabel}  [${operation.capabilityId}, risk: ${operation.riskClass}]`,
    );
    for (const previewLine of operation.preview.text.split("\n")) {
      lines.push(`      ${previewLine}`);
    }
  }
  return lines.join("\n");
}
