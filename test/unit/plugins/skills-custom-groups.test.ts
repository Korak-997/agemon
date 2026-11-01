import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomSkillGroupConfig } from "../../../src/core/config.js";
import { buildConsentGates } from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import {
  type LedgerEntry,
  StateManifest,
} from "../../../src/core/state-manifest.js";
import { resolveStateRoot } from "../../../src/core/state-root.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { buildCustomSkillGroups } from "../../../src/plugins/skills/catalog.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import { resolvePinnedSkillsSourceDirectory } from "../../../src/plugins/skills/pinned-source.js";
import { fingerprintInstalledSkill } from "../../../src/plugins/skills/skill-tree.js";
import type {
  PluginApplyReport,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];
const REMOTE_REF = "4f2c8a1b9d3e5f7a0b2c4d6e8f1a3b5c7d9e0f12";

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
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

async function createSandbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-custom-skills-"));
  createdTempDirectories.push(directory);
  return directory;
}

const HOUSE_STYLE: CustomSkillGroupConfig = {
  id: "house-style",
  label: "House style",
  skills: [
    {
      kind: "local",
      path: "./tools/skills/house-rules",
      skillName: "house-rules",
    },
  ],
};

async function createTestContext(
  customSkillGroups: CustomSkillGroupConfig[] = [HOUSE_STYLE],
  skillGroupsOption = "house-style",
): Promise<Context> {
  const sandboxDirectory = await createSandbox();
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  resetFakeSubprocessState();

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
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    skillGroupsOption,
    customSkillGroups,
  };
}

async function writeLocalSkill(
  repoRoot: string,
  relativeDirectory = "tools/skills/house-rules",
  name = "house-rules",
): Promise<string> {
  const directory = join(repoRoot, relativeDirectory);
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Our rules.\n---\n# Rules\n`,
    "utf8",
  );
  await writeFile(join(directory, "references", "style.md"), "- tabs\n");
  return directory;
}

function planSkills(ctx: Context): Promise<ProposedOperation[]> {
  return (skillsPlugin.plan as NonNullable<typeof skillsPlugin.plan>)(ctx);
}

function applySkills(
  ctx: Context,
  operations: ProposedOperation[],
): Promise<PluginApplyReport | undefined> {
  return (skillsPlugin.apply as NonNullable<typeof skillsPlugin.apply>)(
    ctx,
    operations,
  );
}

function recordSkillsAddSources(ctx: Context): string[] {
  const sources: string[] = [];
  const run = ctx.run;
  ctx.run = async (command, args, options) => {
    if (command === process.execPath && args[1] === "add") {
      sources.push(args[2]);
    }
    return run(command, args, options);
  };
  return sources;
}

function customOperation(operations: ProposedOperation[]): ProposedOperation {
  const operation = operations.find(
    (candidate) => candidate.resourceId === "custom-skill-group:house-style",
  );
  if (operation === undefined) {
    throw new Error("no custom-skill-group:house-style operation");
  }
  return operation;
}

describe("custom skill groups: catalog", () => {
  it("refuses a custom group that reuses a built-in group id or skill name", () => {
    expect(() =>
      buildCustomSkillGroups([{ ...HOUSE_STYLE, id: "security" }]),
    ).toThrow(
      "agemon.toml is invalid: custom_skill_groups.security uses the id of a built-in skill group",
    );
    expect(() =>
      buildCustomSkillGroups([
        {
          ...HOUSE_STYLE,
          skills: [
            {
              kind: "local",
              path: "./tools/agemon-security",
              skillName: "agemon-security",
            },
          ],
        },
      ]),
    ).toThrow("names 'agemon-security', which is a built-in skill");
  });
});

describe("custom skill groups: recorded groups", () => {
  it("does not treat a declined group id as an installed skill of the same name", async () => {
    const ctx = await createTestContext(
      [
        {
          id: "team",
          label: "Team",
          skills: [
            { kind: "local", path: "./tools/security", skillName: "security" },
          ],
        },
      ],
      "essentials",
    );
    await writeLocalSkill(ctx.cwd, "tools/security", "security");
    for (const type of ["offered-skill-group", "declined-skill-group"]) {
      await ctx.manifest.recordAction({
        plugin: "skills",
        type,
        target: "security",
        preExisting: false,
      });
    }

    const operations = await planSkills({ ...ctx, yes: true });

    expect(operations.map((operation) => operation.resourceId)).not.toContain(
      "custom-skill-group:team",
    );
  });
});

describe("custom skill groups: unconfirmed ledger entries", () => {
  function houseRulesEntry() {
    return {
      plugin: "skills",
      type: "installed-skill",
      target: "house-rules",
      preExisting: false,
    };
  }

  it("an unconfirmed entry naming a custom group's skill does not make it recorded", async () => {
    const ctx = await createTestContext([HOUSE_STYLE], "essentials");
    await writeLocalSkill(ctx.cwd);
    await appendLedgerClaims(ctx, [houseRulesEntry()]);

    const operations = await planSkills({ ...ctx, yes: true });

    expect(operations.map((operation) => operation.resourceId)).not.toContain(
      "custom-skill-group:house-style",
    );
  });

  it("a custom group this machine recorded is still repaired when a skill is missing", async () => {
    const ctx = await createTestContext([HOUSE_STYLE], "essentials");
    await writeLocalSkill(ctx.cwd);
    await ctx.manifest.recordAction(houseRulesEntry());

    const operations = await planSkills({ ...ctx, yes: true });

    expect(operations.map((operation) => operation.resourceId)).toContain(
      "custom-skill-group:house-style",
    );
  });
});

describe("custom skill groups: removed from agemon.toml", () => {
  async function orphanRows(ctx: Context) {
    const rows = (await skillsPlugin.describeState?.(ctx)) ?? [];
    return rows.filter((row) => row.resourceId === "skill-groups:orphaned");
  }

  it("status reports skills of a custom group removed from agemon.toml in one orphaned row", async () => {
    const ctx = await createTestContext([], "essentials");
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: "house-rules",
      preExisting: false,
    });

    expect(await orphanRows(ctx)).toEqual([
      {
        capabilityId: "skills",
        resourceId: "skill-groups:orphaned",
        label: "skills of removed groups",
        state: "present-managed",
        detail:
          "house-rules: their skill group is no longer defined; 'agemon nuke --only skills' removes them",
      },
    ]);
  });

  it("orphaned names recorded only by claims are labelled as kept by nuke", async () => {
    const ctx = await createTestContext([], "essentials");
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: "installed-skill",
        target: "house-rules",
        preExisting: false,
      },
    ]);

    expect(await orphanRows(ctx)).toEqual([
      expect.objectContaining({
        state: "present-adopted",
        detail:
          "house-rules: their skill group is no longer defined; 'agemon nuke --only skills' removes them (1 not recorded on this machine; nuke keeps those)",
      }),
    ]);
  });

  it("a recorded built-in group keeps its own row and only the removed group's skill is orphaned", async () => {
    const ctx = await createTestContext([], "essentials");
    for (const target of [
      "web-design-guidelines",
      "writing-guidelines",
      "house-rules",
    ]) {
      await ctx.manifest.recordAction({
        plugin: "skills",
        type: "installed-skill",
        target,
        preExisting: false,
      });
    }

    const rows = (await skillsPlugin.describeState?.(ctx)) ?? [];

    expect(rows.map((row) => row.resourceId)).toEqual([
      "skill-group:essentials",
      "skill-groups:orphaned",
    ]);
    expect(await orphanRows(ctx)).toEqual([
      expect.objectContaining({
        detail:
          "house-rules: their skill group is no longer defined; 'agemon nuke --only skills' removes them",
      }),
    ]);
  });

  it("pre-existing skills are never listed as orphaned", async () => {
    const ctx = await createTestContext([], "essentials");
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "preexisting-skill",
      target: "house-rules",
      preExisting: true,
    });

    expect(await orphanRows(ctx)).toEqual([]);
  });
});

describe("custom skill groups: local sources", () => {
  it("plans one custom-skill-group operation that names the source and its content hash", async () => {
    const ctx = await createTestContext();
    await writeLocalSkill(ctx.cwd);

    const operation = customOperation(await planSkills(ctx));

    expect(operation.action).toBe("install-package");
    expect(operation.riskClass).toBe("executes");
    expect(operation.expectedFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(operation.preview.text).toMatch(
      /^House style:\nhouse-rules — \.\/tools\/skills\/house-rules in this repository, content sha256 [0-9a-f]{16}$/u,
    );
  });

  it("installs from a private staged copy, verifies, reports and is removed by nuke", async () => {
    const ctx = await createTestContext();
    await writeLocalSkill(ctx.cwd);
    const addSources = recordSkillsAddSources(ctx);

    await applySkills(ctx, await planSkills(ctx));

    expect(
      ctx.manifest
        .getActions()
        .find(
          (entry) =>
            entry.type === "installed-skill" && entry.target === "house-rules",
        )?.fingerprintAfter,
    ).toBe(
      await fingerprintInstalledSkill(
        join(ctx.cwd, ".claude/skills/house-rules"),
      ),
    );

    const stagedSource = addSources.find((source) =>
      source.endsWith("/house-rules"),
    );
    expect(stagedSource).toMatch(
      new RegExp(
        `^${resolveStateRoot()}/agemon/skills-stage/run-[^/]+/house-rules$`,
        "u",
      ),
    );
    expect(
      await readdir(join(resolveStateRoot(), "agemon", "skills-stage")),
    ).toEqual([]);
    expect((await skillsPlugin.verify(ctx)).ok).toBe(true);
    const rows = await (
      skillsPlugin.describeState as NonNullable<
        typeof skillsPlugin.describeState
      >
    )(ctx);
    expect(
      rows.find((row) => row.resourceId === "custom-skill-group:house-style"),
    ).toMatchObject({
      label: "House style",
      state: "present-managed",
    });

    await skillsPlugin.uninstall(ctx);
    expect((await skillsPlugin.verify(ctx)).ok).toBe(false);
  });

  it("refuses to apply when the skill changed after planning", async () => {
    const ctx = await createTestContext();
    const directory = await writeLocalSkill(ctx.cwd);
    const operations = await planSkills(ctx);
    await writeFile(join(directory, "references", "style.md"), "- spaces\n");

    await expect(applySkills(ctx, operations)).rejects.toThrow(
      "The custom skill group 'house-style' changed since it was planned. Re-run 'agemon plan' and review it again.",
    );
  });

  it.each([
    [
      "a symlink inside the skill",
      async (repoRoot: string) => {
        const directory = await writeLocalSkill(repoRoot);
        await symlink("/etc/passwd", join(directory, "passwd"));
      },
      /passwd is a symlink or not a regular file/,
    ],
    [
      "a symlinked directory on the way",
      async (repoRoot: string) => {
        const outside = await createSandbox();
        await writeLocalSkill(outside, "skills/house-rules");
        await mkdir(join(repoRoot, "tools"));
        await symlink(join(outside, "skills"), join(repoRoot, "tools/skills"));
      },
      /is a symlink or not a directory/,
    ],
    ["a missing directory", async () => {}, /the directory does not exist/],
    [
      "a missing SKILL.md",
      async (repoRoot: string) => {
        await mkdir(join(repoRoot, "tools/skills/house-rules"), {
          recursive: true,
        });
      },
      /it has no SKILL\.md/,
    ],
    [
      "a SKILL.md with another name",
      async (repoRoot: string) => {
        await writeLocalSkill(repoRoot, undefined, "something-else");
      },
      "its SKILL.md names it 'something-else', but agemon.toml expects 'house-rules'",
    ],
    [
      "a SKILL.md with two names",
      async (repoRoot: string) => {
        const directory = await writeLocalSkill(repoRoot);
        await writeFile(
          join(directory, "SKILL.md"),
          "---\nname: house-rules\nname: other\n---\n",
        );
      },
      "its SKILL.md names it '(no single name)'",
    ],
    [
      "a file that would pass 8 MiB, before reading it",
      async (repoRoot: string) => {
        const directory = await writeLocalSkill(repoRoot);
        await writeFile(
          join(directory, "big.bin"),
          Buffer.alloc(9 * 1024 * 1024),
        );
      },
      /larger than 8 MiB/,
    ],
    [
      "more than 200 entries",
      async (repoRoot: string) => {
        const directory = await writeLocalSkill(repoRoot);
        for (let index = 0; index < 200; index += 1) {
          await writeFile(join(directory, `f${index}`), "");
        }
      },
      /more than 200 entries/,
    ],
  ])("refuses %s", async (_label, arrange, message) => {
    const ctx = await createTestContext();
    await arrange(ctx.cwd);

    await expect(planSkills(ctx)).rejects.toThrow(message);
  });

  it.each([".git", ".GIT", ".agemon"])(
    "refuses a source inside %s",
    async (directory) => {
      const source = `./${directory}/house-rules`;
      const ctx = await createTestContext([
        {
          ...HOUSE_STYLE,
          skills: [{ kind: "local", path: source, skillName: "house-rules" }],
        },
      ]);
      await writeLocalSkill(ctx.cwd, `${directory}/house-rules`);

      await expect(planSkills(ctx)).rejects.toThrow(/Refusing to use/);
    },
  );
});

describe("custom skill groups: GitHub sources", () => {
  const REMOTE: CustomSkillGroupConfig = {
    id: "acme",
    label: "Acme",
    skills: [
      {
        kind: "github",
        owner: "acme",
        repository: "agent-skills",
        ref: REMOTE_REF,
        skillName: "lint-rules",
      },
    ],
  };

  function fakeGitCheckout(ctx: Context, manifestName: string): string[][] {
    const gitCalls: string[][] = [];
    const run = ctx.run;
    ctx.run = async (command, args, options) => {
      if (command !== "git") {
        return run(command, args, options);
      }
      gitCalls.push(args);
      const subcommand = args.slice(6);
      if (subcommand[0] === "checkout") {
        const skillDirectory = join(
          resolvePinnedSkillsSourceDirectory(REMOTE_REF),
          "skills",
          "lint-rules",
        );
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
          join(skillDirectory, "SKILL.md"),
          `---\nname: ${manifestName}\n---\n`,
        );
      }
      if (subcommand[0] === "rev-parse") {
        return {
          code: 0,
          stdout: `${basename(options?.cwd ?? "")}\n`,
          stderr: "",
        };
      }
      if (subcommand[0] === "ls-tree") {
        return {
          code: 0,
          stdout: `100644 blob abc\tskills/lint-rules/SKILL.md\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return gitCalls;
  }

  it("previews the repository and commit, fetches anonymously and adds from the pinned checkout", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    const gitCalls = fakeGitCheckout(ctx, "lint-rules");
    const addSources = recordSkillsAddSources(ctx);

    const operations = await planSkills(ctx);
    expect(
      operations.find(
        (operation) => operation.resourceId === "custom-skill-group:acme",
      )?.preview.text,
    ).toBe(
      `Acme:\nlint-rules — https://github.com/acme/agent-skills at ${REMOTE_REF}`,
    );
    await applySkills(ctx, operations);

    expect(gitCalls).toContainEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "fetch",
      "--depth",
      "1",
      "https://github.com/acme/agent-skills",
      REMOTE_REF,
    ]);
    expect(addSources).toContain(
      join(
        resolvePinnedSkillsSourceDirectory(REMOTE_REF),
        "skills",
        "lint-rules",
      ),
    );
  });

  function withCheckoutStatus(ctx: Context, porcelainStatus: string): void {
    const run = ctx.run;
    ctx.run = async (command, args, options) => {
      const subcommand = args.slice(6);
      if (command === "git" && subcommand[0] === "init") {
        await mkdir(join(options?.cwd ?? "", ".git"), { recursive: true });
      }
      const result = await run(command, args, options);
      return command === "git" && subcommand[0] === "status"
        ? { ...result, stdout: porcelainStatus }
        : result;
    };
  }

  function lintRulesInstallEntry(ctx: Context): LedgerEntry | undefined {
    return ctx.manifest
      .getActions()
      .find(
        (entry) =>
          entry.type === "installed-skill" && entry.target === "lint-rules",
      );
  }

  it("records the installed fingerprint when the cached checkout is pristine, and nuke then removes the copy without git", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    const gitCalls = fakeGitCheckout(ctx, "lint-rules");
    withCheckoutStatus(ctx, "");

    await applySkills(ctx, await planSkills(ctx));

    const copy = join(ctx.cwd, ".claude/skills/lint-rules");
    const entry = lintRulesInstallEntry(ctx);
    expect(entry?.fingerprintAfter).toBe(await fingerprintInstalledSkill(copy));
    expect(entry !== undefined && ctx.manifest.isConfirmed(entry)).toBe(true);
    expect(gitCalls.filter((args) => args.includes("status"))).toEqual([
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "status",
        "--porcelain",
        "--ignored",
      ],
    ]);
    const gitCallsBeforeNuke = gitCalls.length;

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(false);
    expect(gitCalls).toHaveLength(gitCallsBeforeNuke);
  });

  it("records no fingerprint when the cached checkout is not pristine, and nuke keeps the copy", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    fakeGitCheckout(ctx, "lint-rules");
    withCheckoutStatus(ctx, "?? stray\n");

    await applySkills(ctx, await planSkills(ctx));

    expect(lintRulesInstallEntry(ctx)?.fingerprintAfter).toBeNull();
    await skillsPlugin.uninstall(ctx);
    expect(existsSync(join(ctx.cwd, ".claude/skills/lint-rules"))).toBe(true);
  });

  it("records no fingerprint when the cached checkout is at another commit", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    fakeGitCheckout(ctx, "lint-rules");
    withCheckoutStatus(ctx, "");
    const run = ctx.run;
    ctx.run = async (command, args, options) =>
      command === "git" && args.includes("--verify")
        ? { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" }
        : run(command, args, options);

    await applySkills(ctx, await planSkills(ctx));

    expect(lintRulesInstallEntry(ctx)?.fingerprintAfter).toBeNull();
  });

  it("records no fingerprint when the installed copy differs from the cached checkout", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    fakeGitCheckout(ctx, "lint-rules");
    withCheckoutStatus(ctx, "");
    const run = ctx.run;
    ctx.run = async (command, args, options) => {
      const result = await run(command, args, options);
      if (command === process.execPath && args.includes("lint-rules")) {
        await writeFile(
          join(ctx.cwd, ".claude/skills/lint-rules/extra.md"),
          "not from the checkout\n",
        );
      }
      return result;
    };

    await applySkills(ctx, await planSkills(ctx));

    expect(lintRulesInstallEntry(ctx)?.fingerprintAfter).toBeNull();
  });

  it("refuses a fetched skill whose SKILL.md has another name", async () => {
    const ctx = await createTestContext([REMOTE], "acme");
    fakeGitCheckout(ctx, "Lint-Rules");

    await expect(applySkills(ctx, await planSkills(ctx))).rejects.toThrow(
      "its SKILL.md names it 'Lint-Rules', but agemon.toml expects 'lint-rules'",
    );
    expect(existsSync(join(ctx.cwd, ".agents"))).toBe(false);
  });
});

describe("custom skill groups: consent", () => {
  it("routes custom groups and their declines to their own gate, which always shows the sources", async () => {
    const ctx = await createTestContext();
    await writeLocalSkill(ctx.cwd);
    const operations = await planSkills(ctx);

    const gates = buildConsentGates({
      isolationStatus: "ignored",
      plan: {
        id: "0123456789abcdef",
        agemonVersion: "9.9.9",
        desiredStateHash: "hash",
        inputs: { capabilityIds: ["skills"], skillGroups: "house-style" },
        createdAt: "2026-10-29T00:00:00.000Z",
        operations,
      },
    });

    expect(gates.map((gate) => gate.id)).toEqual([
      "install-custom-skills",
      "install-tooling",
    ]);
    expect(
      gates[0].operations.map((operation) => operation.resourceId),
    ).toEqual(["custom-skill-group:house-style"]);
    expect(gates[0].forcesDiff).toBe(true);
    expect(gates[0].summary).toContain(
      "defined in this repository's agemon.toml",
    );
  });
});
