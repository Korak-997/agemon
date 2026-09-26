import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  resetFakeSubprocessState,
  runSubprocess,
} from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";

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
    async isActive() {
      return { active: false };
    },
    async registerAutostart() {
      return {
        unitPath: "",
        lingerEnabledByAgemon: false,
      };
    },
    async unregisterAutostart() {
      return;
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
  delete process.env.AGEMON_FAKE_PREINSTALLED_SKILLS;

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
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
    skillGroupsOption: undefined,
  };
}

const PRE_UPGRADE_GROUP_IDS = ["essentials", "security"];

async function installAsPreUpgradeProject(context: Context): Promise<void> {
  const preUpgradeSkillNames = PRE_UPGRADE_GROUP_IDS.flatMap(
    (groupId) => findSkillGroup(groupId)?.skills ?? [],
  ).map((skill) => skill.skillName);

  process.env.AGEMON_FAKE_PREINSTALLED_SKILLS = preUpgradeSkillNames.join(",");

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
  it("offers a catalog group added after the project's original install", async () => {
    const context = await createTestContext({ interactive: false });
    await installAsPreUpgradeProject(context);

    const planBeforeInteractive = await planSkills(context);
    expect(planBeforeInteractive).not.toEqual([]);
    const [gateOperation] = planBeforeInteractive;
    for (const groupId of ["design", "code-quality", "architecture"]) {
      const group = findSkillGroup(groupId);
      expect(gateOperation.preview.text).toContain(group?.label);
    }
    expect(gateOperation.preview.text).not.toContain("Essentials");
    expect(gateOperation.preview.text).not.toContain("Security");

    context.interactive = true;
    clack.multiselect.mockResolvedValueOnce(["architecture"]);

    await skillsPlugin.install(context);

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

    await skillsPlugin.install(context);
    expect(clack.multiselect).not.toHaveBeenCalled();

    const planAfterNonInteractiveInstall = await planSkills(context);
    expect(planAfterNonInteractiveInstall).not.toEqual([]);
    const [gateOperation] = planAfterNonInteractiveInstall;
    expect(gateOperation.preview.text).toContain(
      findSkillGroup("architecture")?.label,
    );

    context.interactive = true;
    clack.multiselect.mockResolvedValueOnce(["architecture"]);
    await skillsPlugin.install(context);

    const offeredGroupIds = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredGroupIds).toContain("architecture");
  });

  it("does not re-offer a group once it has been declined", async () => {
    const context = await createTestContext({ interactive: true });
    await installAsPreUpgradeProject(context);

    clack.multiselect.mockResolvedValueOnce([]);
    await skillsPlugin.install(context);
    expect(clack.multiselect).toHaveBeenCalledTimes(1);

    const planAfterDecline = await planSkills(context);
    expect(planAfterDecline).toEqual([]);

    await skillsPlugin.install(context);
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
