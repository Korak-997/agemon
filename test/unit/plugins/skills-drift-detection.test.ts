import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";

const clack = vi.hoisted(() => ({
  multiselect: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  multiselect: clack.multiselect,
  select: vi.fn(),
  cancel: clack.cancel,
  isCancel: (value: unknown) => typeof value === "symbol",
}));

import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import {
  findSkillGroup,
  SKILL_GROUPS,
} from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import { applyAllPlanned } from "../apply-all-planned.js";
import { seedInstalledSkills } from "../installed-skills.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  clack.multiselect.mockReset();
  clack.cancel.mockReset();
  resetFakeSubprocessState();
});

function createNoOpServiceManager(): ServiceManager {
  return {
    kind: "systemd-user",
    async isActive() {
      return { active: false, failed: false };
    },
    async isSandboxEnforced() {
      return false;
    },
    async registerAutostart() {
      return {
        unitPath: "",
        attemptLabel: "strict",
        failedAttempts: [],
      };
    },
    async unregisterAutostart() {},
    async readUnitWorkingDirectory() {
      return null;
    },
    async readUnitEnvironment() {
      return null;
    },
    unitPathFor: (unitName) => `/fake/systemd/user/${unitName}`,
    async isLingerEnabled() {
      return false;
    },
    async enableLinger() {},
    async disableLinger() {},
    async findAgemonDaemonUnit() {
      return null;
    },
  };
}

function createNoOpUi(): Context["ui"] {
  return {
    start() {
      return;
    },
    succeed() {
      return;
    },
    fail() {
      return;
    },
    info() {
      return;
    },
  };
}

async function createTestContext(overrides: {
  interactive: boolean;
  yes?: boolean;
}): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-skills-test-"));
  createdTempDirectories.push(sandboxDirectory);

  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";

  return {
    cwd: sandboxDirectory,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: overrides.yes ?? false,
    interactive: overrides.interactive,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: createNoOpUi(),
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    skillGroupsOption: undefined,
  };
}

const PRE_UPGRADE_GROUP_IDS = ["essentials", "security"];

async function installAsPreUpgradeProject(context: Context): Promise<void> {
  const preUpgradeSkillNames = PRE_UPGRADE_GROUP_IDS.flatMap(
    (groupId) => findSkillGroup(groupId)?.skills ?? [],
  ).map((skill) => skill.skillName);

  await seedInstalledSkills(context.cwd, preUpgradeSkillNames);

  for (const skillName of preUpgradeSkillNames) {
    await context.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: skillName,
      preExisting: false,
    });
  }
}

async function planSkills(context: Context) {
  if (!skillsPlugin.plan) {
    throw new Error("skillsPlugin.plan is not defined");
  }
  return skillsPlugin.plan(context);
}

async function describeSkillsState(context: Context) {
  if (!skillsPlugin.describeState) {
    throw new Error("skillsPlugin.describeState is not defined");
  }
  return skillsPlugin.describeState(context);
}

describe("skills plugin drift detection", () => {
  it("offers a catalog group added after the project's original install only when someone can answer", async () => {
    const context = await createTestContext({ interactive: false });
    await installAsPreUpgradeProject(context);

    expect(await planSkills(context)).toEqual([]);

    context.interactive = true;
    clack.multiselect.mockResolvedValueOnce(["architecture"]);

    await applyAllPlanned(skillsPlugin, context);

    expect(clack.multiselect).toHaveBeenCalledTimes(1);
    const offeredGroupIds = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredGroupIds).not.toContain("essentials");
    expect(offeredGroupIds).not.toContain("security");
    expect(offeredGroupIds).toContain("architecture");

    const installedSkillNames = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills")
      .map((action) => action.target);
    for (const skill of findSkillGroup("architecture")?.skills ?? []) {
      expect(installedSkillNames).toContain(skill.skillName);
    }

    const planAfterDecision = await planSkills(context);
    expect(planAfterDecision).toEqual([]);
  });

  it("keeps a newly added group pending after a non-interactive, non-consenting install", async () => {
    const context = await createTestContext({ interactive: false, yes: false });
    await installAsPreUpgradeProject(context);

    await applyAllPlanned(skillsPlugin, context);
    expect(clack.multiselect).not.toHaveBeenCalled();

    expect(await planSkills(context)).toEqual([]);
    expect(
      context.manifest
        .getActions()
        .filter((action) => action.type === "offered-skill-group"),
    ).toEqual([]);

    context.interactive = true;
    clack.multiselect.mockResolvedValueOnce(["architecture"]);
    await applyAllPlanned(skillsPlugin, context);

    const offeredGroupIds = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredGroupIds).toContain("architecture");
  });

  it("offers geo-seo exactly once to a project installed before it existed", async () => {
    const context = await createTestContext({ interactive: true });
    await installAsPreUpgradeProject(context);
    for (const group of SKILL_GROUPS.filter(({ id }) => id !== "geo-seo")) {
      await context.manifest.recordAction({
        plugin: "skills",
        type: "offered-skill-group",
        target: group.id,
        preExisting: false,
      });
    }

    clack.multiselect.mockResolvedValueOnce([]);
    await applyAllPlanned(skillsPlugin, context);

    expect(clack.multiselect).toHaveBeenCalledTimes(1);
    const offeredGroupIds = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredGroupIds).toEqual(["geo-seo"]);

    await applyAllPlanned(skillsPlugin, context);
    expect(clack.multiselect).toHaveBeenCalledTimes(1);
    expect(await planSkills(context)).toEqual([]);
  });

  it("does not re-offer a group once it has been declined", async () => {
    const context = await createTestContext({ interactive: true });
    await installAsPreUpgradeProject(context);

    clack.multiselect.mockResolvedValueOnce([]);
    await applyAllPlanned(skillsPlugin, context);
    expect(clack.multiselect).toHaveBeenCalledTimes(1);

    const planAfterDecline = await planSkills(context);
    expect(planAfterDecline).toEqual([]);

    await applyAllPlanned(skillsPlugin, context);
    expect(clack.multiselect).toHaveBeenCalledTimes(1);

    const declinedActions = context.manifest
      .getActions()
      .filter(
        (action) =>
          action.plugin === "skills" && action.type === "declined-skill-group",
      )
      .map((action) => action.target);
    for (const groupId of ["design", "code-quality", "architecture"]) {
      expect(declinedActions).toContain(groupId);
    }

    const stateRows = await describeSkillsState(context);
    for (const groupId of ["design", "code-quality"]) {
      const group = findSkillGroup(groupId);
      const row = stateRows.find(
        (candidate) => candidate.resourceId === `skill-group:${groupId}`,
      );
      expect(row).toBeDefined();
      expect(row?.label).toBe(group?.label);
      expect(row?.state).toBe("declined");
    }
  });
});
