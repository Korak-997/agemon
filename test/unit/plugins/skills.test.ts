import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { withAgemonStateLock } from "../../../src/core/state-root.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import {
  ESSENTIALS_SKILLS_COMMIT,
  ESSENTIALS_SKILLS_REPOSITORY_URL,
} from "../../../src/plugins/pins.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import { applyAllPlanned } from "../apply-all-planned.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function createNoOpServiceManager(): ServiceManager {
  return {
    kind: "systemd-user",
    async isActive() {
      return { active: false };
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

async function createTestContext(skillGroupsOption?: string): Promise<Context> {
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
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    skillGroupsOption,
  };
}

describe("skills plugin", () => {
  it("installs, verifies, and uninstalls managed skills", async () => {
    const context = await createTestContext();

    const detectedBeforeInstall = await skillsPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await applyAllPlanned(skillsPlugin, context);

    const verificationAfterInstall = await skillsPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "skills");
    expect(actionsAfterInstall.map((action) => action.type).sort()).toEqual([
      "generated-skills-lock",
      "installed-skill",
      "installed-skill",
    ]);
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

  it("waits for another run's Essentials install before fetching the pinned source", async () => {
    const context = await createTestContext();
    const gitCalls: string[][] = [];
    const run = context.run;
    context.run = async (command, args, options) => {
      if (command === "git") {
        gitCalls.push(args);
      }
      return run(command, args, options);
    };
    let releaseOtherRun: () => void = () => {};
    let signalHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const otherRun = withAgemonStateLock(
      "skills-src.lock",
      () =>
        new Promise<void>((resolve) => {
          releaseOtherRun = resolve;
          signalHeld();
        }),
      1_000,
    );
    await held;

    const install = applyAllPlanned(skillsPlugin, context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gitCalls).toEqual([]);
    releaseOtherRun();
    await otherRun;
    await install;

    expect(gitCalls.length).toBeGreaterThan(0);
    await uninstallPlugins({ ...context, yes: true }, [skillsPlugin], {});
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

    await applyAllPlanned(skillsPlugin, context);

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

  it("records the directories and the .gitignore line it added, and nuke leaves no trace of them", async () => {
    const context = await createTestContext();

    await applyAllPlanned(skillsPlugin, context);

    expect(
      context.manifest
        .getActions()
        .filter((action) => action.plugin === "workspace")
        .map((action) => action.resourceId),
    ).toEqual([
      "created-directory:.claude",
      "created-directory:.claude/skills",
      "gitignore-line:/skills-lock.json",
    ]);

    await uninstallPlugins({ ...context, yes: true }, [skillsPlugin], {});

    for (const leftover of [
      ".claude",
      ".agents",
      "skills-lock.json",
      ".gitignore",
      ".agemon",
    ]) {
      expect(existsSync(join(context.cwd, leftover))).toBe(false);
    }
  });

  it("bounds a skills add failure message to the last 10 lines of stderr", async () => {
    resetFakeSubprocessState();
    const context = await createTestContext();
    const run = context.run;
    const stderr = Array.from({ length: 5_000 }, (_, i) => `npx ${i}`).join(
      "\n",
    );
    context.run = async (command, args, options) =>
      command === process.execPath && args[1] === "add"
        ? { code: 1, stdout: "", stderr }
        : run(command, args, options);

    const failure = (await applyAllPlanned(skillsPlugin, context).catch(
      (error: unknown) => error,
    )) as Error;

    expect(failure.message).toMatch(/^skills add failed for /);
    expect(failure.message.split("\n").length).toBeLessThanOrEqual(11);
    expect(failure.message).toContain("npx 4999");
  });

  it("uninstalls without running any subprocess when no skill was installed, still removing agemon's skills-lock.json", async () => {
    const context = await createTestContext();
    const lockPath = join(context.cwd, "skills-lock.json");
    await writeFile(lockPath, '{"version":1,"skills":{}}\n', "utf8");
    await context.manifest.recordAction({
      plugin: "skills",
      type: "generated-skills-lock",
      target: "skills-lock.json",
      preExisting: false,
    });
    const commands: string[][] = [];
    context.run = async (command, args) => {
      commands.push([command, ...args]);
      return { code: 1, stdout: "", stderr: "offline" };
    };

    await skillsPlugin.uninstall(context);

    expect(commands).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not touch .gitignore when a skills-lock.json already existed", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "skills-lock.json"), "{}\n", "utf8");

    await applyAllPlanned(skillsPlugin, context);

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

    await applyAllPlanned(skillsPlugin, context);

    const installedSkillNames = context.manifest
      .getActions()
      .filter((action) => action.type === "installed-skill")
      .map((action) => action.target);
    expect(installedSkillNames.sort()).toEqual(
      findSkillGroup("essentials")
        ?.skills.map((skill) => skill.skillName)
        .sort(),
    );
  });

  it("installs an explicitly requested group on top of the defaults", async () => {
    const context = await createTestContext("architecture");

    await applyAllPlanned(skillsPlugin, context);

    const installedSkillNames = context.manifest
      .getActions()
      .filter((action) => action.type === "installed-skill")
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

    await applyAllPlanned(skillsPlugin, context);

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

    await applyAllPlanned(skillsPlugin, context);

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
        "-c",
        "credential.helper=",
        "fetch",
        "--depth",
        "1",
        ESSENTIALS_SKILLS_REPOSITORY_URL,
        ESSENTIALS_SKILLS_COMMIT,
      ],
    ]);
  });

  it("adds every geo-seo skill through the pinned CLI with --skill-groups geo-seo, and nuke removes them without it", async () => {
    const context = await createTestContext("geo-seo");
    const skillsCliArgs: string[][] = [];
    const runAndRecord = context.run;
    context.run = async (command, args, options) => {
      if (command === process.execPath) skillsCliArgs.push(args);
      return runAndRecord(command, args, options);
    };
    const geoSeoSkills = findSkillGroup("geo-seo")?.skills ?? [];

    await applyAllPlanned(skillsPlugin, context);

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

    const callsBeforeNuke = skillsCliArgs.length;
    await uninstallPlugins({ ...context, yes: true }, [skillsPlugin], {});

    expect(skillsCliArgs).toHaveLength(callsBeforeNuke);
    for (const skill of geoSeoSkills) {
      expect(
        existsSync(join(context.cwd, ".claude/skills", skill.skillName)),
      ).toBe(false);
    }
    expect(
      context.manifest
        .getActions()
        .filter((action) => action.plugin === "skills"),
    ).toEqual([]);
  });

  it("rejects an unknown skill group id", async () => {
    const context = await createTestContext("not-a-real-group");

    await expect(applyAllPlanned(skillsPlugin, context)).rejects.toThrow(
      "Unknown skill group id(s): not-a-real-group",
    );
  });

  it("verification does not require groups outside the ones actually installed", async () => {
    const context = await createTestContext("architecture");
    await applyAllPlanned(skillsPlugin, context);
    const verification = await skillsPlugin.verify(context);
    expect(verification.ok).toBe(true);
    expect(verification.detail).toContain("2 skill group(s)");
  });
});
