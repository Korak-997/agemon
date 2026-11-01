import type {
  ProposedOperation,
  ProposedOperationAction,
  RiskClass,
  SkillUpdate,
} from "./types.js";

interface DescribeOperationInput {
  capabilityId: string;
  resourceId: string;
  targetPath: string;
  action: ProposedOperationAction;
  riskClass: RiskClass;
  requiresConsent: boolean;
  expectedFingerprint?: string | null;
  preview: { kind: "diff" | "note"; text: string };
  updates?: SkillUpdate[];
}

export function describeOperation(
  input: DescribeOperationInput,
): ProposedOperation {
  return {
    ...(input.updates === undefined ? {} : { updates: input.updates }),
    id: `${input.capabilityId}:${input.resourceId}:${input.action}`,
    capabilityId: input.capabilityId,
    resourceId: input.resourceId,
    targetPath: input.targetPath,
    action: input.action,
    riskClass: input.riskClass,
    requiresConsent: input.requiresConsent,
    expectedFingerprint: input.expectedFingerprint ?? null,
    preview: input.preview,
  };
}
