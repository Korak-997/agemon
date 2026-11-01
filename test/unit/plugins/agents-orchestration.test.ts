import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../../src/core/apply.js";
import type { Context } from "../../../src/core/context.js";
import { buildPlan, uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { agentsPlugin } from "../../../src/plugins/agents/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createTestContext(): Promise<Context> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-agents-orchestration-"));
  createdTempDirectories.push(cwd);
  return {
    cwd,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: { log() {}, error() {} },
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(cwd),
    serviceManager: {} as Context["serviceManager"],
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

const GEO_GROUP_OPERATION: ProposedOperation = {
  id: "skills:skill-group:geo-seo:install-package",
  capabilityId: "skills",
  resourceId: "skill-group:geo-seo",
  targetPath: "",
  action: "install-package",
  riskClass: "executes",
  requiresConsent: true,
  expectedFingerprint: null,
  preview: { kind: "note", text: "GEO" },
};

function standInSkillsPlugin(
  events: string[],
  behaviour: { applyThrows?: boolean } = {},
): AgemonPlugin {
  return {
    id: "skills",
    async detect() {
      return { present: false, preExisting: false };
    },
    async plan() {
      return [GEO_GROUP_OPERATION];
    },
    async apply(ctx) {
      if (behaviour.applyThrows) {
        throw new Error("skills add failed");
      }
      await ctx.manifest.recordAction({
        plugin: "skills",
        type: "installed-skill",
        target: "geo-audit",
        preExisting: false,
      });
    },
    async install() {},
    async verify() {
      return { ok: true };
    },
    async uninstall() {
      events.push("skills");
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe("agents with the skills capability", () => {
  it("plans agents for a group the same plan installs, after it", async () => {
    const context = await createTestContext();

    const plan = await buildPlan(
      context,
      [agentsPlugin, standInSkillsPlugin([])],
      { agemonVersion: "9.9.9" },
    );

    expect(plan.operations.map((operation) => operation.capabilityId)).toEqual([
      "skills",
      "agents",
      "agents",
      "agents",
      "agents",
      "agents",
    ]);
  });

  it("pulls skills in when only agents is requested", async () => {
    const context = await createTestContext();

    const plan = await buildPlan(
      context,
      [standInSkillsPlugin([]), agentsPlugin],
      { only: ["agents"], agemonVersion: "9.9.9" },
    );

    expect(plan.inputs.capabilityIds).toEqual(["skills", "agents"]);
    expect(plan.operations[0]).toEqual(GEO_GROUP_OPERATION);
  });

  it("writes no agent file when the skills capability fails first", async () => {
    const context = await createTestContext();
    const skills = standInSkillsPlugin([], { applyThrows: true });
    const plan = await buildPlan(context, [agentsPlugin, skills], {
      agemonVersion: "9.9.9",
    });

    await expect(
      applyPlan(context, [agentsPlugin, skills], {
        plan,
        approved: plan.operations,
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/skills add failed/);

    expect(await exists(join(context.cwd, ".claude"))).toBe(false);
    expect(
      context.manifest
        .getActions()
        .filter((entry) => entry.plugin === "agents"),
    ).toEqual([]);
  });

  it("installs agents after their group, and nuke removes agents before skills", async () => {
    const context = await createTestContext();
    const events: string[] = [];
    const skills = standInSkillsPlugin(events);
    const plan = await buildPlan(context, [skills, agentsPlugin], {
      agemonVersion: "9.9.9",
    });
    await applyPlan(context, [skills, agentsPlugin], {
      plan,
      approved: plan.operations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    });
    expect(
      await exists(join(context.cwd, ".claude/agents/geo-audit-schema.md")),
    ).toBe(true);
    const trackingAgents: AgemonPlugin = {
      ...agentsPlugin,
      async uninstall(ctx) {
        events.push("agents");
        await agentsPlugin.uninstall(ctx);
      },
    };

    await uninstallPlugins(context, [skills, trackingAgents], {});

    expect(events).toEqual(["agents", "skills"]);
    expect(await exists(join(context.cwd, ".claude/agents"))).toBe(false);
  });

  it("keeps skills when only skills is nuked while agents are installed", async () => {
    const context = await createTestContext();
    const events: string[] = [];
    const skills = standInSkillsPlugin(events);
    await context.manifest.recordAction({
      plugin: "agents",
      type: "managed-agent-file",
      target: ".claude/agents/geo-audit-schema.md",
      preExisting: false,
      resourceId: "agent-file:geo-audit-schema",
    });

    await uninstallPlugins(context, [skills, agentsPlugin], {
      only: ["skills"],
    });

    expect(events).toEqual([]);
  });
});
