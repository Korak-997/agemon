import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import {
  ESSENTIALS_SKILLS_COMMIT,
  ESSENTIALS_SKILLS_REPOSITORY_URL,
} from "../../../src/plugins/pins.js";
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
        attemptLabel: "strict",
        failedAttempts: [],
      };
    },
    async unregisterAutostart() {
      return { lingerKeptFor: null };
    },
    async readUnitWorkingDirectory() {
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
    yes: false,
    interactive: false,
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
    verifiedBinaryInstaller: { install: async () => {} },
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

    await uninstallPlugins({ ...context, yes: true }, [skillsPlugin], {});

    const verificationAfterUninstall = await skillsPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills");
    expect(actionsAfterUninstall).toEqual([]);
  });

  it("git-ignores a skills-lock.json generated during install", async () => {
    const context = await createTestContext();
    const skillsLockPath = join(context.cwd, "skills-lock.json");
    const runWithoutLockSideEffect = context.run;
    context.run = async (command, args, options) => {
      const result = await runWithoutLockSideEffect(command, args, options);
      if (command === process.execPath && args[1] === "add") {
        await writeFile(skillsLockPath, "{}\n", "utf8");
      }
      return result;
    };

    await skillsPlugin.install(context);

    const lockRecords = context.manifest
      .getActions()
      .filter(
        (action) =>
          action.plugin === "skills" && action.type === "generated-skills-lock",
      );
    expect(lockRecords).toHaveLength(1);

    const gitignoreLines = (
      await readFile(join(context.cwd, ".gitignore"), "utf8")
    ).split(/\r?\n/);
    expect(gitignoreLines).toContain("/skills-lock.json");
  });

  it("does not touch .gitignore when a skills-lock.json already existed", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "skills-lock.json"), "{}\n", "utf8");

    await skillsPlugin.install(context);

    const lockRecords = context.manifest
      .getActions()
      .filter(
        (action) =>
          action.plugin === "skills" && action.type === "generated-skills-lock",
      );
    expect(lockRecords).toHaveLength(0);
    await expect(
      readFile(join(context.cwd, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs only the default group in a non-interactive session", async () => {
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

  it("adds every skill through the pinned CLI, Essentials from the verified commit", async () => {
    const context = await createTestContext();
    resetFakeSubprocessState();
    const calls: Array<[string, string[]]> = [];
    const runAndRecord = context.run;
    context.run = async (command, args, options) => {
      calls.push([command, args]);
      return runAndRecord(command, args, options);
    };

    await skillsPlugin.install(context);

    const skillsCliCalls = calls.filter(
      ([command]) => command === process.execPath,
    );
    expect(calls.some(([command]) => command === "npx")).toBe(false);
    expect(skillsCliCalls.length).toBeGreaterThan(0);
    for (const [, args] of skillsCliCalls) {
      expect(args[0]).toMatch(
        /\/agemon\/tools\/[0-9a-f]{16}\/node_modules\/skills\/bin\/cli\.mjs$/u,
      );
    }
    const addedSources = skillsCliCalls
      .filter(([, args]) => args[1] === "add")
      .map(([, args]) => args[2]);
    const pinnedSourceDirectory = join(
      process.env.XDG_STATE_HOME ?? "",
      "agemon",
      "skills-src",
      ESSENTIALS_SKILLS_COMMIT,
    );
    expect(addedSources).toEqual([
      join(pinnedSourceDirectory, "skills", "web-design-guidelines"),
      join(pinnedSourceDirectory, "skills", "writing-guidelines"),
    ]);
    expect(calls).toContainEqual([
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "fetch",
        "--depth",
        "1",
        ESSENTIALS_SKILLS_REPOSITORY_URL,
        ESSENTIALS_SKILLS_COMMIT,
      ],
    ]);
  });

  it("adds and removes every geo-seo skill through the pinned CLI with --skill-groups geo-seo", async () => {
    const context = await createTestContext("geo-seo");
    const skillsCliArgs: string[][] = [];
    const runAndRecord = context.run;
    context.run = async (command, args, options) => {
      if (command === process.execPath) skillsCliArgs.push(args);
      return runAndRecord(command, args, options);
    };
    const geoSeoSkills = findSkillGroup("geo-seo")?.skills ?? [];

    await skillsPlugin.install(context);

    for (const skill of geoSeoSkills) {
      expect(skillsCliArgs).toContainEqual([
        expect.any(String),
        "add",
        skill.source,
        "--skill",
        skill.skillName,
        "--agent",
        "claude-code",
        "--yes",
      ]);
    }

    await uninstallPlugins({ ...context, yes: true }, [skillsPlugin], {});

    const removedSkillNames = skillsCliArgs
      .filter((args) => args[1] === "remove")
      .flatMap((args) => args.slice(2));
    for (const skill of geoSeoSkills) {
      expect(removedSkillNames).toContain(skill.skillName);
    }
    expect(
      context.manifest
        .getActions()
        .filter((action) => action.plugin === "skills"),
    ).toEqual([]);
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
    const verification = await skillsPlugin.verify(context);
    expect(verification.ok).toBe(true);
    expect(verification.detail).toContain("2 skill group(s)");
  });
});
