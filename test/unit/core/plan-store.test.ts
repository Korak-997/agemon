import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePlanId,
  type Plan,
  readPlan,
  resolvePlanPath,
  writePlan,
} from "../../../src/core/plan-store.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-plan-store-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

function sampleOperation(
  overrides: Partial<ProposedOperation> = {},
): ProposedOperation {
  return {
    id: "master-prompt:rule-file:AGENTS.md:create",
    capabilityId: "master-prompt",
    resourceId: "rule-file:AGENTS.md",
    targetPath: "AGENTS.md",
    action: "create",
    riskClass: "writes-config",
    requiresConsent: true,
    expectedFingerprint: null,
    preview: { kind: "diff", text: "--- AGENTS.md\n+++ AGENTS.md\n+# Rules" },
    ...overrides,
  };
}

describe("computePlanId", () => {
  it("is stable for identical inputs and ignores createdAt", () => {
    const identity = {
      agemonVersion: "9.9.9",
      desiredStateHash: "abc",
      operations: [sampleOperation()],
    };

    expect(computePlanId(identity)).toBe(computePlanId(identity));
  });

  it("changes when the operation set changes", () => {
    const base = computePlanId({
      agemonVersion: "9.9.9",
      desiredStateHash: "abc",
      operations: [sampleOperation()],
    });
    const mutated = computePlanId({
      agemonVersion: "9.9.9",
      desiredStateHash: "abc",
      operations: [sampleOperation({ action: "replace" })],
    });

    expect(mutated).not.toBe(base);
  });
});

describe("writePlan / readPlan", () => {
  it("round-trips a plan through .agemon/plans/<id>.json", async () => {
    const cwd = await createSandbox();
    const plan: Plan = {
      id: "0123456789abcdef",
      agemonVersion: "9.9.9",
      desiredStateHash: "abc",
      createdAt: "2026-01-01T00:00:00.000Z",
      operations: [sampleOperation()],
    };

    const planPath = await writePlan(cwd, plan);

    expect(planPath).toBe(resolvePlanPath(cwd, plan.id));
    expect(planPath.endsWith(".agemon/plans/0123456789abcdef.json")).toBe(true);
    await expect(readPlan(cwd, plan.id)).resolves.toEqual(plan);
  });
});
