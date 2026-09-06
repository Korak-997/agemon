import type {
  ProposedOperation,
  ProposedOperationAction,
  RiskClass,
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
}

export function describeOperation(
  input: DescribeOperationInput,
): ProposedOperation {
  return {
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
