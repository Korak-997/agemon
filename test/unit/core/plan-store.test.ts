import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
      inputs: { capabilityIds: ["master-prompt"], skillGroups: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      operations: [sampleOperation()],
    };

    const planPath = await writePlan(cwd, plan);

    expect(planPath).toBe(resolvePlanPath(cwd, plan.id));
    expect(planPath.endsWith(".agemon/plans/0123456789abcdef.json")).toBe(true);
    await expect(readPlan(cwd, plan.id)).resolves.toEqual(plan);
  });
});

const VALID_PLAN_ID = "0123456789abcdef";

function validPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: VALID_PLAN_ID,
    agemonVersion: "9.9.9",
    desiredStateHash: "abc",
    inputs: { capabilityIds: ["master-prompt"], skillGroups: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    operations: [sampleOperation()],
    ...overrides,
  };
}

async function plantPlanFile(
  cwd: string,
  planId: string,
  contents: unknown,
): Promise<void> {
  await mkdir(join(cwd, ".agemon/plans"), { recursive: true });
  await writeFile(
    join(cwd, ".agemon/plans", `${planId}.json`),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}

describe("readPlan validation", () => {
  it.each(["../x", "ABC", "0123456789abcde", "0123456789abcdeF"])(
    "refuses the plan id %j before touching the plan directory",
    async (planId) => {
      const cwd = await createSandbox();
      await plantPlanFile(cwd, "0123456789abcde", validPlan());

      await expect(readPlan(cwd, planId)).rejects.toThrow(
        /Invalid plan id .*expected 16 lowercase hex characters/,
      );
    },
  );

  it("refuses an invalid id without creating .agemon/", async () => {
    const cwd = await createSandbox();

    await expect(readPlan(cwd, "../x")).rejects.toThrow(/Invalid plan id/);
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it("explains a missing plan", async () => {
    const cwd = await createSandbox();

    await expect(readPlan(cwd, VALID_PLAN_ID)).rejects.toThrow(
      `No plan ${VALID_PLAN_ID} in .agemon/plans/. Run 'agemon plan' first.`,
    );
  });

  it.each<[string, unknown]>([
    ["a missing field", { ...validPlan(), desiredStateHash: undefined }],
    ["a wrong type", { ...validPlan(), operations: "nope" }],
    ["missing inputs", { ...validPlan(), inputs: undefined }],
    [
      "non-array input capabilities",
      {
        ...validPlan(),
        inputs: { capabilityIds: "skills", skillGroups: null },
      },
    ],
    [
      "a control character in the input skill groups",
      {
        ...validPlan(),
        inputs: { capabilityIds: ["skills"], skillGroups: "all\u001b[2J" },
      },
    ],
    [
      "an unknown action",
      validPlan({
        operations: [
          sampleOperation({
            action: "format-disk" as ProposedOperation["action"],
          }),
        ],
      }),
    ],
    [
      "an unknown risk class",
      validPlan({
        operations: [
          sampleOperation({
            riskClass: "harmless" as ProposedOperation["riskClass"],
          }),
        ],
      }),
    ],
    [
      "an id other than the requested one",
      validPlan({ id: "fedcba9876543210" }),
    ],
    [
      "a non-canonical ./ target path",
      validPlan({
        operations: [sampleOperation({ targetPath: "./CLAUDE.md" })],
      }),
    ],
    [
      "a target path with ..",
      validPlan({ operations: [sampleOperation({ targetPath: "a/../b" })] }),
    ],
    [
      "a target path with a trailing slash",
      validPlan({ operations: [sampleOperation({ targetPath: "x/" })] }),
    ],
    [
      "a newline in a resource id",
      validPlan({
        operations: [sampleOperation({ resourceId: "rule-file:A\nfake line" })],
      }),
    ],
    [
      "an escape sequence in a target path",
      validPlan({
        operations: [sampleOperation({ targetPath: "AGENTS\u001b[2J.md" })],
      }),
    ],
    [
      "a target path of ..",
      validPlan({ operations: [sampleOperation({ targetPath: ".." })] }),
    ],
    [
      "a target path of .",
      validPlan({ operations: [sampleOperation({ targetPath: "." })] }),
    ],
    [
      "an install-package marked inert and needing no consent",
      validPlan({
        operations: [
          sampleOperation({
            action: "install-package",
            riskClass: "inert",
            requiresConsent: false,
          }),
        ],
      }),
    ],
    [
      "a file create marked inert and needing no consent",
      validPlan({
        operations: [
          sampleOperation({
            action: "create",
            riskClass: "inert",
            requiresConsent: false,
          }),
        ],
      }),
    ],
    [
      "a use-shared operation that asks for consent",
      validPlan({
        operations: [
          sampleOperation({
            action: "use-shared",
            riskClass: "inert",
            requiresConsent: true,
          }),
        ],
      }),
    ],
    [
      "a use-shared operation with another risk class",
      validPlan({
        operations: [
          sampleOperation({
            action: "use-shared",
            riskClass: "executes",
            requiresConsent: false,
          }),
        ],
      }),
    ],
  ])("refuses a plan with %s", async (_label, contents) => {
    const cwd = await createSandbox();
    await plantPlanFile(cwd, VALID_PLAN_ID, contents);

    await expect(readPlan(cwd, VALID_PLAN_ID)).rejects.toThrow(
      `Plan ${VALID_PLAN_ID} is invalid`,
    );
  });

  it("refuses a plan file that is not JSON", async () => {
    const cwd = await createSandbox();
    await plantPlanFile(cwd, VALID_PLAN_ID, "{ not json");

    await expect(readPlan(cwd, VALID_PLAN_ID)).rejects.toThrow(
      `Plan ${VALID_PLAN_ID} is invalid`,
    );
  });

  it("never echoes raw control characters from an unparsable plan", async () => {
    const cwd = await createSandbox();
    await plantPlanFile(cwd, VALID_PLAN_ID, "\u001b[2J");

    const error = await readPlan(cwd, VALID_PLAN_ID).catch(
      (caught: Error) => caught,
    );

    expect((error as Error).message).toMatch(/is invalid: not valid JSON/);
    expect((error as Error).message).not.toContain("\u001b");
  });

  it("keeps CRLF and control characters inside a preview, and drops unknown keys", async () => {
    const cwd = await createSandbox();
    const plan = validPlan({
      operations: [
        sampleOperation({
          preview: { kind: "diff", text: "-old\r\n+new\r\n\f" },
        }),
      ],
    });
    await plantPlanFile(cwd, VALID_PLAN_ID, {
      ...plan,
      injected: true,
      operations: [{ ...plan.operations[0], extra: "dropped" }],
    });

    await expect(readPlan(cwd, VALID_PLAN_ID)).resolves.toEqual(plan);
  });

  it("refuses a symlinked plan file", async () => {
    const cwd = await createSandbox();
    const outside = await createSandbox();
    await writeFile(join(outside, "plan.json"), JSON.stringify(validPlan()));
    await mkdir(join(cwd, ".agemon/plans"), { recursive: true });
    await symlink(
      join(outside, "plan.json"),
      join(cwd, ".agemon/plans", `${VALID_PLAN_ID}.json`),
    );

    await expect(readPlan(cwd, VALID_PLAN_ID)).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("refuses a symlinked .agemon/plans directory", async () => {
    const cwd = await createSandbox();
    const outside = await createSandbox();
    await writeFile(
      join(outside, `${VALID_PLAN_ID}.json`),
      JSON.stringify(validPlan()),
    );
    await mkdir(join(cwd, ".agemon"));
    await symlink(outside, join(cwd, ".agemon/plans"));

    await expect(readPlan(cwd, VALID_PLAN_ID)).rejects.toThrow(
      /symlink or not a directory/,
    );
  });
});
