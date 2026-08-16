import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
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

async function createTestContext(skillGroupsOption?: string): Promise<Context> {
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
    yes: true,
    confirm: async () => false,
    log: console,
    ui: createNoOpUi(),
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    skillGroupsOption,
  };
}

describe("skills plugin", () => {
  it("installs, verifies, and uninstalls managed skills", async () => {
    const context = await createTestContext();

    const detectedBeforeInstall = await skillsPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await skillsPlugin.install(context);

    const verificationAfterInstall = await skillsPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills");
    expect(actionsAfterInstall.length).toBe(2);
    expect(
      actionsAfterInstall.every((action) => action.preExisting === false),
    ).toBe(true);

    await skillsPlugin.uninstall(context);

    const verificationAfterUninstall = await skillsPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills");
    expect(actionsAfterUninstall).toEqual([]);
  });

  it("declines every optional group when confirm always says no", async () => {
    const context = await createTestContext();

    await skillsPlugin.install(context);

    const installedSkillNames = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills")
      .map((action) => action.target);
    expect(installedSkillNames.sort()).toEqual(
      findSkillGroup("essentials")
        ?.skills.map((skill) => skill.skillName)
        .sort(),
    );
  });

  it("installs an explicitly requested group on top of the defaults", async () => {
    const context = await createTestContext("architecture");

    await skillsPlugin.install(context);

    const installedSkillNames = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills")
      .map((action) => action.target);
    const expectedSkillNames = [
      ...(findSkillGroup("essentials")?.skills ?? []),
      ...(findSkillGroup("architecture")?.skills ?? []),
    ].map((skill) => skill.skillName);
    expect(installedSkillNames.sort()).toEqual(expectedSkillNames.sort());

    const verification = await skillsPlugin.verify(context);
    expect(verification.ok).toBe(true);
  });

  it("installs every group with --skill-groups all", async () => {
    const context = await createTestContext("all");

    await skillsPlugin.install(context);

    const installedSkillNames = new Set(
      context.manifest
        .getActions()
        .filter((action) => action.plugin === "skills")
        .map((action) => action.target),
    );
    expect(installedSkillNames.has("agemon-design")).toBe(true);
    expect(installedSkillNames.has("agemon-security")).toBe(true);
    expect(installedSkillNames.has("agemon-architecture")).toBe(true);
    expect(installedSkillNames.has("agemon-performance")).toBe(true);
  });

  it("rejects an unknown skill group id", async () => {
    const context = await createTestContext("not-a-real-group");

    await expect(skillsPlugin.install(context)).rejects.toThrow(
      "Unknown skill group id(s): not-a-real-group",
    );
  });

  it("verification does not require groups outside the ones actually installed", async () => {
    const context = await createTestContext("architecture");
    await skillsPlugin.install(context);

    // Regression guard: verify() must scope to recorded groups, not the full
    // static catalog — installing only "essentials" + "architecture" must
    // not fail verification just because "design" was never selected.
    const verification = await skillsPlugin.verify(context);
    expect(verification.ok).toBe(true);
    expect(verification.detail).toContain("2 skill group(s)");
  });
});
