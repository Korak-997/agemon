import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import {
  ESSENTIALS_SKILLS_COMMIT,
  ESSENTIALS_SKILLS_REPOSITORY_URL,
} from "../../../src/plugins/pins.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";
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
      return { active: false };
    },
    async registerAutostart() {
      return { unitPath: "", attemptLabel: "strict", failedAttempts: [] };
    },
    async unregisterAutostart() {},
    async readUnitWorkingDirectory() {
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

interface TestContextOptions {
  interactive?: boolean;
  yes?: boolean;
  skillGroupsOption?: string;
  preinstalledSkills?: string[];
}

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-skills-plan-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

async function createTestContext(
  options: TestContextOptions = {},
): Promise<Context> {
  const sandboxDirectory = await createSandbox();
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  process.env.AGEMON_FAKE_PREINSTALLED_SKILLS = (
    options.preinstalledSkills ?? []
  ).join(",");
  resetFakeSubprocessState();

  return {
    cwd: sandboxDirectory,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: options.yes ?? false,
    interactive: options.interactive ?? false,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    skillGroupsOption: options.skillGroupsOption,
  };
}

function planSkills(ctx: Context): Promise<ProposedOperation[]> {
  return (skillsPlugin.plan as NonNullable<typeof skillsPlugin.plan>)(ctx);
}

function applySkills(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<void> {
  return (skillsPlugin.apply as NonNullable<typeof skillsPlugin.apply>)(
    ctx,
    operations,
  );
}

function recordSkillCliCalls(ctx: Context): string[][] {
  const calls: string[][] = [];
  const run = ctx.run;
  ctx.run = async (command, args, options) => {
    if (command === process.execPath) {
      calls.push(args.slice(1));
    }
    return run(command, args, options);
  };
  return calls;
}

function skillNamesOf(groupId: string): string[] {
  return (findSkillGroup(groupId)?.skills ?? []).map(
    (skill) => skill.skillName,
  );
}

async function recordInstalledGroups(
  ctx: Context,
  groupIds: string[],
): Promise<void> {
  for (const skillName of groupIds.flatMap(skillNamesOf)) {
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: skillName,
      preExisting: false,
    });
  }
}

describe("skills plan: one operation per group", () => {
  it("lists each group with its skills and pinned sources", async () => {
    const ctx = await createTestContext({ skillGroupsOption: "security" });

    const operations = await planSkills(ctx);

    expect(operations.map((operation) => operation.resourceId)).toEqual([
      "skill-group:essentials",
      "skill-group:security",
    ]);
    expect(
      operations.every(
        (operation) =>
          operation.action === "install-package" &&
          operation.riskClass === "executes" &&
          operation.requiresConsent,
      ),
    ).toBe(true);
    expect(operations[0].preview.text).toBe(
      [
        "Essentials:",
        `web-design-guidelines — ${ESSENTIALS_SKILLS_REPOSITORY_URL} at ${ESSENTIALS_SKILLS_COMMIT}`,
        `writing-guidelines — ${ESSENTIALS_SKILLS_REPOSITORY_URL} at ${ESSENTIALS_SKILLS_COMMIT}`,
      ].join("\n"),
    );
    expect(operations[1].preview.text).toBe(
      "Security:\nagemon-security — bundled with agemon",
    );
  });

  it("plans nothing when every recorded group is installed (old ledger)", async () => {
    const ctx = await createTestContext({
      preinstalledSkills: [
        ...skillNamesOf("essentials"),
        ...skillNamesOf("security"),
      ],
    });
    await recordInstalledGroups(ctx, ["essentials", "security"]);

    expect(await planSkills(ctx)).toEqual([]);
  });

  it("plans a repair of only the recorded group that lost a skill (old ledger)", async () => {
    const ctx = await createTestContext({
      preinstalledSkills: skillNamesOf("essentials"),
    });
    await recordInstalledGroups(ctx, ["essentials", "security"]);

    const operations = await planSkills(ctx);

    expect(operations.map((operation) => operation.resourceId)).toEqual([
      "skill-group:security",
    ]);
  });
});

describe("skills plan: group choice at plan time", () => {
  it("turns the multiselect answer into installs and declines", async () => {
    const ctx = await createTestContext({ interactive: true });
    clack.multiselect.mockResolvedValueOnce(["design"]);

    const operations = await planSkills(ctx);

    const installs = operations.filter(
      (operation) => operation.action === "install-package",
    );
    const declines = operations.filter(
      (operation) => operation.action === "skip",
    );
    expect(installs.map((operation) => operation.resourceId)).toEqual([
      "skill-group:essentials",
      "skill-group:design",
    ]);
    expect(declines.map((operation) => operation.resourceId)).toContain(
      "skill-group:security",
    );
    expect(declines.map((operation) => operation.resourceId)).not.toContain(
      "skill-group:design",
    );
    expect(
      declines.every(
        (operation) =>
          operation.riskClass === "inert" && operation.requiresConsent,
      ),
    ).toBe(true);

    await applySkills(ctx, operations);

    const declined = ctx.manifest
      .getActions()
      .filter((action) => action.type === "declined-skill-group")
      .map((action) => action.target);
    expect(declined).toContain("security");
    expect(declined).not.toContain("design");
    expect(await planSkills(ctx)).toEqual([]);
    expect(clack.multiselect).toHaveBeenCalledTimes(1);
  });

  it("exits on a cancelled prompt before any ledger write or skills CLI call", async () => {
    const ctx = await createTestContext({ interactive: true });
    const skillCliCalls = recordSkillCliCalls(ctx);
    clack.multiselect.mockResolvedValueOnce(Symbol("cancel"));
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(planSkills(ctx)).rejects.toThrow("exit 130");

    expect(ctx.manifest.getActions()).toEqual([]);
    expect(skillCliCalls).toEqual([]);
  });
});

describe("skills apply", () => {
  it("installs exactly the planned groups even when this run would choose more", async () => {
    const planningCtx = await createTestContext();
    const operations = await planSkills(planningCtx);
    const applyingCtx = { ...planningCtx, yes: true, interactive: true };

    await applySkills(applyingCtx, operations);

    expect(clack.multiselect).not.toHaveBeenCalled();
    const installed = applyingCtx.manifest
      .getActions()
      .filter((action) => action.type === "installed-skill")
      .map((action) => action.target);
    expect(installed).toEqual(skillNamesOf("essentials"));
  });

  it("refuses a skill group the catalog does not know", async () => {
    const ctx = await createTestContext();
    const unknownGroup = describeOperation({
      capabilityId: "skills",
      resourceId: "skill-group:not-a-group",
      targetPath: "",
      action: "install-package",
      riskClass: "executes",
      requiresConsent: true,
      preview: { kind: "note", text: "" },
    });

    await expect(applySkills(ctx, [unknownGroup])).rejects.toThrow(
      "The plan names skill group resource 'skill-group:not-a-group', which agemon does not know. Re-run 'agemon plan'.",
    );
  });

  it("refuses an action the skills capability never plans", async () => {
    const ctx = await createTestContext();
    const [install] = await planSkills(ctx);

    await expect(
      applySkills(ctx, [{ ...install, action: "replace" }]),
    ).rejects.toThrow(
      "The skills capability does not replace 'skill-group:essentials'.",
    );
  });
});

describe("skills detect", () => {
  it("writes nothing to the ledger, even for unrecorded installed skills", async () => {
    const ctx = await createTestContext({
      preinstalledSkills: skillNamesOf("essentials"),
    });
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: skillNamesOf("essentials")[0],
      preExisting: false,
    });
    const ledgerBefore = structuredClone(ctx.manifest.getActions());

    const presence = await skillsPlugin.detect(ctx);

    expect(presence).toEqual({ present: true, preExisting: true });
    expect(ctx.manifest.getActions()).toEqual(ledgerBefore);
  });
});

describe("the skills CLI only writes inside the repository", () => {
  async function installEssentials(ctx: Context): Promise<void> {
    await applySkills(ctx, await planSkills(ctx));
  }

  it.each([".agents/skills", ".claude"])(
    "refuses to install through a symlinked %s",
    async (relativePath) => {
      const ctx = await createTestContext();
      const outside = await createSandbox();
      await mkdir(join(ctx.cwd, relativePath, ".."), { recursive: true });
      await symlink(outside, join(ctx.cwd, relativePath));
      const skillCliCalls = recordSkillCliCalls(ctx);

      await expect(installEssentials(ctx)).rejects.toThrow(
        /is a symlink or not a directory/,
      );

      expect(skillCliCalls.filter((args) => args[0] === "add")).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("refuses to install over a symlinked skills-lock.json", async () => {
    const ctx = await createTestContext();
    const outside = await createSandbox();
    const outsideFile = join(outside, "bashrc");
    await writeFile(outsideFile, "keep me\n", "utf8");
    await symlink(outsideFile, join(ctx.cwd, "skills-lock.json"));

    await expect(installEssentials(ctx)).rejects.toThrow(
      "Refusing to run the skills CLI: skills-lock.json is a symlink or not a regular file.",
    );
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("keep me\n");
  });

  it("removes only through the claude-code agent and cleans the canonical copy, leaving other agents' directories alone", async () => {
    const ctx = await createTestContext();
    await installEssentials(ctx);
    const [skillName] = skillNamesOf("essentials");
    await mkdir(join(ctx.cwd, ".agents/skills", skillName), {
      recursive: true,
    });
    const outside = await createSandbox();
    await mkdir(join(outside, skillName));
    await mkdir(join(ctx.cwd, ".cursor"));
    await symlink(outside, join(ctx.cwd, ".cursor/skills"));
    const skillCliCalls = recordSkillCliCalls(ctx);

    await skillsPlugin.uninstall(ctx);

    const removals = skillCliCalls.filter((args) => args[0] === "remove");
    expect(removals.length).toBe(skillNamesOf("essentials").length);
    for (const args of removals) {
      expect(args.slice(2)).toEqual(["--agent", "claude-code", "--yes"]);
    }
    expect(existsSync(join(ctx.cwd, ".agents/skills", skillName))).toBe(false);
    expect(existsSync(join(outside, skillName))).toBe(true);
  });

  it("refuses a forged ledger skill name that would leave .agents/skills, before running the CLI", async () => {
    const forgedName = "../../..";
    const ctx = await createTestContext({ preinstalledSkills: [forgedName] });
    await mkdir(join(ctx.cwd, ".agents/skills"), { recursive: true });
    const sibling = join(ctx.cwd, "..", `${basename(ctx.cwd)}-precious.txt`);
    await writeFile(sibling, "keep\n");
    createdTempDirectories.push(sibling);
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: forgedName,
      preExisting: false,
    });
    const skillCliCalls = recordSkillCliCalls(ctx);

    await expect(skillsPlugin.uninstall(ctx)).rejects.toThrow(
      "Refusing to run the skills CLI: the skill name '../../..' is not a plain skill name. The ledger in .agemon/state.json may have been edited",
    );

    expect(skillCliCalls.filter((args) => args[0] === "remove")).toEqual([]);
    await expect(readFile(sibling, "utf8")).resolves.toBe("keep\n");
  });

  it("creates no agent directories when nuke finds none", async () => {
    const ctx = await createTestContext({
      preinstalledSkills: skillNamesOf("essentials"),
    });
    await recordInstalledGroups(ctx, ["essentials"]);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(ctx.cwd, ".agents"))).toBe(false);
    expect(existsSync(join(ctx.cwd, ".claude"))).toBe(false);
  });
});
