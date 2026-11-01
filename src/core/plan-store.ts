import { join, posix } from "node:path";
import {
  PROPOSED_OPERATION_ACTIONS,
  type ProposedOperation,
  RISK_CLASSES,
  type SkillUpdate,
} from "../plugins/types.js";
import { isPlainSkillName } from "./config.js";
import { readRegularFileIfExists, writeFileAtomic } from "./files.js";
import { fingerprintJson } from "./fingerprint.js";
import { AGEMON_STATE_DIRECTORY, resolveStateDirectory } from "./repo-paths.js";
import { validateUntrustedGitConfig } from "./untrusted-git-config.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

export const PLAN_SEGMENTS = ["plans"] as const;
const PLAN_ID_LENGTH = 16;
const PLAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const SKILL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export interface PlanInputs {
  capabilityIds: string[];
  skillGroups: string | null;
}

export interface Plan {
  id: string;
  agemonVersion: string;
  desiredStateHash: string;
  inputs: PlanInputs;
  createdAt: string;
  operations: ProposedOperation[];
}

interface PlanIdentityInput {
  agemonVersion: string;
  desiredStateHash: string;
  operations: ProposedOperation[];
}

export function resolveDesiredStateHash(inputs: PlanInputs): string {
  return fingerprintJson(inputs);
}

export function planContentFingerprint(input: PlanIdentityInput): string {
  return fingerprintJson({
    agemonVersion: input.agemonVersion,
    desiredStateHash: input.desiredStateHash,
    operations: input.operations,
  });
}

export function computePlanId(input: PlanIdentityInput): string {
  return planContentFingerprint(input).slice(0, PLAN_ID_LENGTH);
}

export function assertValidPlanId(planId: string): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Error(
      `Invalid plan id '${printable(planId)}': expected 16 lowercase hex characters, as printed by 'agemon plan'.`,
    );
  }
}

export function resolvePlanPath(cwd: string, planId: string): string {
  assertValidPlanId(planId);
  return join(cwd, AGEMON_STATE_DIRECTORY, ...PLAN_SEGMENTS, `${planId}.json`);
}

export async function writePlan(cwd: string, plan: Plan): Promise<string> {
  const planPath = resolvePlanPath(cwd, plan.id);
  const payload = `${JSON.stringify(plan, null, 2)}\n`;

  await resolveStateDirectory(cwd, [...PLAN_SEGMENTS], { create: true });
  await writeFileAtomic(planPath, payload);
  return planPath;
}

function isCanonicalTargetPath(targetPath: string): boolean {
  return (
    targetPath === "" ||
    (posix.normalize(targetPath) === targetPath &&
      !posix.isAbsolute(targetPath) &&
      targetPath !== "." &&
      targetPath !== ".." &&
      !targetPath.startsWith("../") &&
      !targetPath.startsWith("./") &&
      !targetPath.endsWith("/"))
  );
}

function validateSkillUpdates(
  value: unknown,
  field: string,
  fail: (detail: string) => never,
): SkillUpdate[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(`'${field}' must be a non-empty array`);
  }
  const seenNames = new Set<string>();
  return value.map((update: unknown, index) => {
    const record =
      typeof update === "object" && update !== null
        ? (update as Record<string, unknown>)
        : {};
    const { name, installedFingerprint, currentFingerprint } = record;
    if (
      typeof name !== "string" ||
      !isPlainSkillName(name) ||
      typeof installedFingerprint !== "string" ||
      !SKILL_FINGERPRINT_PATTERN.test(installedFingerprint) ||
      typeof currentFingerprint !== "string" ||
      !SKILL_FINGERPRINT_PATTERN.test(currentFingerprint)
    ) {
      return fail(
        `'${field}[${index}]' must name a plain skill and two 64-character hex fingerprints`,
      );
    }
    if (seenNames.has(name)) {
      return fail(`'${field}[${index}]' names ${name} a second time`);
    }
    seenNames.add(name);
    return { name, installedFingerprint, currentFingerprint };
  });
}

function validatePlan(parsed: unknown, planId: string): Plan {
  const fail = (detail: string): never => {
    throw new Error(`Plan ${planId} is invalid: ${detail}`);
  };
  const asRecord = (value: unknown, field: string): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail(`'${field}' must be an object`);
  const identifier = (value: unknown, field: string): string =>
    typeof value === "string" && isSafeIdentifier(value)
      ? value
      : fail(`'${field}' must be a string without control characters`);
  const oneOf = <Value extends string>(
    allowed: readonly Value[],
    value: unknown,
    field: string,
  ): Value =>
    allowed.includes(value as Value)
      ? (value as Value)
      : fail(`'${field}' must be one of ${allowed.join(", ")}`);

  const plan = asRecord(parsed, "plan");
  if (plan.id !== planId) {
    fail("its id does not match the requested plan id");
  }
  if (plan.inputs === undefined) {
    fail(
      "it has no 'inputs'; it was made before this agemon. Re-run 'agemon plan'",
    );
  }
  const inputs = asRecord(plan.inputs, "inputs");
  if (!Array.isArray(inputs.capabilityIds)) {
    fail("'inputs.capabilityIds' must be an array");
  }
  const capabilityIds = (inputs.capabilityIds as unknown[]).map(
    (capabilityId, index) =>
      identifier(capabilityId, `inputs.capabilityIds[${index}]`),
  );
  const skillGroups =
    inputs.skillGroups === null
      ? null
      : identifier(inputs.skillGroups, "inputs.skillGroups");
  if (!Array.isArray(plan.operations)) {
    fail("'operations' must be an array");
  }

  const operations = (plan.operations as unknown[]).map((value, index) => {
    const field = (name: string) => `operations[${index}].${name}`;
    const operation = asRecord(value, `operations[${index}]`);
    const preview = asRecord(operation.preview, field("preview"));
    const targetPath = identifier(operation.targetPath, field("targetPath"));
    if (!isCanonicalTargetPath(targetPath)) {
      fail(`'${field("targetPath")}' is not a canonical relative path`);
    }
    const expectedFingerprint =
      operation.expectedFingerprint === null
        ? null
        : identifier(
            operation.expectedFingerprint,
            field("expectedFingerprint"),
          );
    if (typeof operation.requiresConsent !== "boolean") {
      fail(`'${field("requiresConsent")}' must be a boolean`);
    }
    if (typeof preview.text !== "string") {
      fail(`'${field("preview.text")}' must be a string`);
    }
    const action = oneOf(
      PROPOSED_OPERATION_ACTIONS,
      operation.action,
      field("action"),
    );
    const riskClass = oneOf(
      RISK_CLASSES,
      operation.riskClass,
      field("riskClass"),
    );
    const needsNoConsent = riskClass === "inert" && !operation.requiresConsent;
    if (action === "use-shared" && !needsNoConsent) {
      fail(
        `'operations[${index}]' is a use-shared operation, which must be inert and need no consent`,
      );
    }
    if (action !== "use-shared" && needsNoConsent) {
      fail(
        `'operations[${index}]' marks ${action} as needing no consent; re-run 'agemon plan'`,
      );
    }
    const untrustedGitConfig =
      operation.untrustedGitConfig === undefined
        ? undefined
        : validateUntrustedGitConfig(
            operation.untrustedGitConfig,
            field("untrustedGitConfig"),
            fail,
          );
    const updates =
      operation.updates === undefined
        ? undefined
        : validateSkillUpdates(operation.updates, field("updates"), fail);
    return {
      ...(untrustedGitConfig === undefined ? {} : { untrustedGitConfig }),
      ...(updates === undefined ? {} : { updates }),
      id: identifier(operation.id, field("id")),
      capabilityId: identifier(operation.capabilityId, field("capabilityId")),
      resourceId: identifier(operation.resourceId, field("resourceId")),
      targetPath,
      action,
      riskClass,
      requiresConsent: operation.requiresConsent as boolean,
      expectedFingerprint,
      preview: {
        kind: oneOf(
          ["diff", "note"] as const,
          preview.kind,
          field("preview.kind"),
        ),
        text: preview.text as string,
      },
    };
  });

  return {
    id: planId,
    agemonVersion: identifier(plan.agemonVersion, "agemonVersion"),
    desiredStateHash: identifier(plan.desiredStateHash, "desiredStateHash"),
    inputs: { capabilityIds, skillGroups },
    createdAt: identifier(plan.createdAt, "createdAt"),
    operations,
  };
}

export async function readPlan(cwd: string, planId: string): Promise<Plan> {
  const planPath = resolvePlanPath(cwd, planId);
  const plansDirectory = await resolveStateDirectory(cwd, [...PLAN_SEGMENTS], {
    create: false,
  });
  const contents =
    plansDirectory === null ? null : await readRegularFileIfExists(planPath);
  if (contents === null) {
    throw new Error(
      `No plan ${planId} in .agemon/plans/. Run 'agemon plan' first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Plan ${planId} is invalid: not valid JSON (${printable((error as Error).message)})`,
    );
  }
  return validatePlan(parsed, planId);
}
