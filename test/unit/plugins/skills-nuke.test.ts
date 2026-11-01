import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import { resolvePinnedSkillsSourceDirectory } from "../../../src/plugins/skills/pinned-source.js";
import { fingerprintInstalledSkill } from "../../../src/plugins/skills/skill-tree.js";
import { assertSkillsCliTargetsStayInRepo } from "../../../src/plugins/skills/skills-cli-targets.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const shippedHistory = vi.hoisted(() => ({
  history: {} as Record<string, string[]>,
  pinned: {} as Record<string, Record<string, string>>,
}));

vi.mock("../../../src/plugins/skills/bundle-fingerprints.js", () => ({
  BUNDLE_FINGERPRINTS: shippedHistory,
}));

const raceHooks = vi.hoisted(() => ({
  afterFingerprint: [] as Array<() => Promise<void>>,
  afterResolvingClaudeSkills: [] as Array<null | (() => Promise<void>)>,
}));

vi.mock("../../../src/plugins/skills/skill-tree.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/plugins/skills/skill-tree.js")
    >();
  return {
    ...actual,
    fingerprintInstalledSkill: async (directory: string) => {
      const fingerprint = await actual.fingerprintInstalledSkill(directory);
      await raceHooks.afterFingerprint.shift()?.();
      return fingerprint;
    },
  };
});

vi.mock("../../../src/core/repo-paths.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/repo-paths.js")>();
  return {
    ...actual,
    resolveRepoDirectory: async (
      ...args: Parameters<typeof actual.resolveRepoDirectory>
    ) => {
      const resolved = await actual.resolveRepoDirectory(...args);
      if (args[1] === ".claude/skills") {
        await raceHooks.afterResolvingClaudeSkills.shift()?.();
      }
      return resolved;
    },
  };
});

const LOCK_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/skills-lock-1.7.2.json", import.meta.url),
    "utf8",
  ),
) as {
  cliVersion: string;
  lock: string;
  afterRemovingAgemonSecurity: string;
};
const TOOLS_MANIFEST = JSON.parse(
  readFileSync(
    new URL("../../../assets/tools/package.json", import.meta.url),
    "utf8",
  ),
) as { dependencies: Record<string, string> };

const COMMIT = "agemon-commit";
const SECURITY = "agemon-security";
const runningAsRoot = process.getuid?.() === 0;
const createdTempDirectories: string[] = [];

beforeEach(() => {
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  resetFakeSubprocessState();
  shippedHistory.history = {};
  shippedHistory.pinned = {};
  raceHooks.afterFingerprint = [];
  raceHooks.afterResolvingClaudeSkills = [];
});

afterEach(async () => {
  expect(raceHooks.afterFingerprint).toEqual([]);
  expect(raceHooks.afterResolvingClaudeSkills).toEqual([]);
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await chmod(directoryPath, 0o700).catch(() => undefined);
    await rm(directoryPath, { recursive: true, force: true });
  }
  resetFakeSubprocessState();
});

interface NukeContext extends Context {
  infoLines: string[];
  commands: string[][];
}

async function createTestContext(dryRun = false): Promise<NukeContext> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-skills-nuke-"));
  createdTempDirectories.push(cwd);
  const infoLines: string[] = [];
  const commands: string[][] = [];
  return {
    infoLines,
    commands,
    cwd,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun,
    yes: true,
    interactive: false,
    confirm: async () => false,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: {
      start() {},
      succeed() {},
      fail() {},
      info(line: string) {
        infoLines.push(line);
      },
    },
    run: async (command, args, options) => {
      commands.push([command, ...args]);
      return runSubprocess(command, args, options);
    },
    manifest: await StateManifest.load(cwd),
    serviceManager: {} as ServiceManager,
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

async function recordInstalled(
  ctx: Context,
  skillName: string,
  installedFingerprint: string | null = null,
): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "skills",
    type: "installed-skill",
    target: skillName,
    preExisting: false,
    fingerprintAfter: installedFingerprint,
  });
}

async function recordGeneratedLock(ctx: Context): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "skills",
    type: "generated-skills-lock",
    target: "skills-lock.json",
    preExisting: false,
  });
}

async function installCurrent(
  ctx: Context,
  groupDirectory: string,
  skillName: string,
): Promise<string> {
  const copy = join(ctx.cwd, ".claude/skills", skillName);
  await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
  await cp(resolveVendoredSkillPath(groupDirectory, skillName), copy, {
    recursive: true,
  });
  await recordInstalled(ctx, skillName);
  return copy;
}

async function writeSkill(
  directory: string,
  contents = "---\nname: agemon-commit\n---\n\nold\n",
): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), contents);
  return directory;
}

function withHouseStyleGroup(ctx: NukeContext): NukeContext {
  return {
    ...ctx,
    customSkillGroups: [
      {
        id: "house-style",
        label: "House style",
        skills: [
          {
            kind: "local",
            path: "./tools/skills/house-rules",
            skillName: "house-rules",
          },
        ],
      },
    ],
  };
}

function keptLine(skillName: string): string {
  return `Keeping .claude/skills/${skillName}: it differs from every version agemon installed; delete it if you no longer need it.`;
}

function skillsCommands(ctx: NukeContext): string[][] {
  return ctx.commands.filter(
    ([command, ...args]) =>
      command === "npm" ||
      args.some((arg) => arg.endsWith("skills/bin/cli.mjs")),
  );
}

describe("nuke removes skills without the skills CLI", () => {
  it("nuke never runs the skills CLI", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);

    await skillsPlugin.uninstall(ctx);

    expect(skillsCommands(ctx)).toEqual([]);
  });

  it("nuke removes a current copy and unlinks a symlinked one without touching its target", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await writeSkill(
      join(ctx.cwd, "elsewhere/agemon-security"),
    );
    await symlink(outside, join(ctx.cwd, ".claude/skills", SECURITY));
    await recordInstalled(ctx, SECURITY);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(ctx.cwd, ".claude/skills", COMMIT))).toBe(false);
    expect(existsSync(join(ctx.cwd, ".claude/skills", SECURITY))).toBe(false);
    expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
  });

  it("nuke keeps an edited copy and a copy with an extra file, says so, and finishes", async () => {
    const ctx = await createTestContext();
    const commitCopy = await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(commitCopy, "SKILL.md"), "my edit\n");
    const securityCopy = await installCurrent(ctx, "security", SECURITY);
    await writeFile(join(securityCopy, "notes.md"), "mine\n");

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(commitCopy)).toBe(true);
    expect(existsSync(join(securityCopy, "notes.md"))).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(COMMIT));
    expect(ctx.infoLines).toContain(keptLine(SECURITY));
  });

  it("nuke keeps a copy over the entry cap without failing", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    for (let index = 0; index < 201; index += 1) {
      await writeFile(join(copy, `f${index}`), "x");
    }

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(COMMIT));
  });

  it("nuke keeps a copy over the depth cap without failing", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    const deepDirectory = join(copy, ...Array.from({ length: 9 }, () => "d"));
    await mkdir(deepDirectory, { recursive: true });
    await writeFile(join(deepDirectory, "deep.md"), "x");

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(deepDirectory, "deep.md"))).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(COMMIT));
  });

  it("nuke keeps a copy over the size cap without failing", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(copy, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(copy, "big.bin"))).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(COMMIT));
  });

  it("nuke removes a historical copy and a custom-group copy that matches its recorded install", async () => {
    const ctx = await createTestContext();
    const historical = await writeSkill(
      join(ctx.cwd, ".claude/skills", COMMIT),
    );
    shippedHistory.history[COMMIT] = [
      await fingerprintInstalledSkill(historical),
    ];
    await recordInstalled(ctx, COMMIT);
    const houseCopy = await writeSkill(
      join(ctx.cwd, ".claude/skills/house-rules"),
      "---\nname: house-rules\n---\n",
    );
    await recordInstalled(
      ctx,
      "house-rules",
      await fingerprintInstalledSkill(houseCopy),
    );

    await skillsPlugin.uninstall(withHouseStyleGroup(ctx));

    expect(existsSync(historical)).toBe(false);
    expect(existsSync(houseCopy)).toBe(false);
  });

  it("nuke keeps a custom-group copy with no recorded install fingerprint, even when it matches the current source", async () => {
    const ctx = await createTestContext();
    const houseSource = await writeSkill(
      join(ctx.cwd, "tools/skills/house-rules"),
      "---\nname: house-rules\n---\n",
    );
    const houseCopy = join(ctx.cwd, ".claude/skills/house-rules");
    await cp(houseSource, houseCopy, { recursive: true });
    await recordInstalled(ctx, "house-rules");

    await skillsPlugin.uninstall(withHouseStyleGroup(ctx));

    expect(existsSync(join(houseCopy, "SKILL.md"))).toBe(true);
    expect(ctx.infoLines).toContain(keptLine("house-rules"));
  });

  it("nuke keeps a custom-group copy edited after its recorded install", async () => {
    const ctx = await createTestContext();
    const houseCopy = await writeSkill(
      join(ctx.cwd, ".claude/skills/house-rules"),
      "---\nname: house-rules\n---\n",
    );
    await recordInstalled(
      ctx,
      "house-rules",
      await fingerprintInstalledSkill(houseCopy),
    );
    await writeFile(join(houseCopy, "notes.md"), "mine\n");

    await skillsPlugin.uninstall(withHouseStyleGroup(ctx));

    expect(existsSync(join(houseCopy, "notes.md"))).toBe(true);
    expect(ctx.infoLines).toContain(keptLine("house-rules"));
  });

  it("nuke refuses a forged skill name before removing any skill", async () => {
    const ctx = await createTestContext();
    const commitCopy = await installCurrent(ctx, "commit", COMMIT);
    await recordInstalled(ctx, "../../outside");

    await expect(skillsPlugin.uninstall(ctx)).rejects.toThrow(
      "not a plain skill name",
    );

    expect(existsSync(join(commitCopy, "SKILL.md"))).toBe(true);
  });

  it("nuke says it unlinked a symlinked copy and left its target alone", async () => {
    const ctx = await createTestContext();
    const outside = await writeSkill(join(ctx.cwd, "elsewhere", COMMIT));
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(outside, join(ctx.cwd, ".claude/skills", COMMIT));
    await recordInstalled(ctx, COMMIT);

    await skillsPlugin.uninstall(ctx);

    expect(ctx.infoLines).toContain(
      `Removed the symlink .claude/skills/${COMMIT}; its target was left alone.`,
    );
  });

  it("dry run prints the same keep and remove decisions and changes nothing", async () => {
    const ctx = await createTestContext(true);
    const commitCopy = await installCurrent(ctx, "commit", COMMIT);
    const securityCopy = await installCurrent(ctx, "security", SECURITY);
    await writeFile(join(securityCopy, "SKILL.md"), "my edit\n");

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(commitCopy)).toBe(true);
    expect(ctx.infoLines).toContain(`Would remove skill ${COMMIT}`);
    expect(ctx.infoLines).toContain(
      `Would keep .claude/skills/${SECURITY}: it differs from every version agemon installed; delete it if you no longer need it.`,
    );
  });

  it("a symlinked .claude/skills is kept with a message and not followed", async () => {
    const ctx = await createTestContext();
    await writeSkill(join(ctx.cwd, "real", COMMIT));
    await mkdir(join(ctx.cwd, ".claude"));
    await symlink(join(ctx.cwd, "real"), join(ctx.cwd, ".claude/skills"));
    await recordInstalled(ctx, COMMIT);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(ctx.cwd, "real", COMMIT, "SKILL.md"))).toBe(true);
    expect(ctx.infoLines).toContain(
      `Keeping .claude/skills/${COMMIT}: .claude/skills is a symlink or not a real directory; agemon leaves it alone.`,
    );
  });
});

describe("nuke when the copy or its parent changes during removal", () => {
  async function outsideRepositoryCopy(
    groupDirectory: string,
    skillName: string,
  ): Promise<string> {
    const outside = await mkdtemp(join(tmpdir(), "agemon-skills-outside-"));
    createdTempDirectories.push(outside);
    await cp(
      resolveVendoredSkillPath(groupDirectory, skillName),
      join(outside, "skills", skillName),
      { recursive: true },
    );
    return outside;
  }

  async function swapClaudeDirectoryFor(
    ctx: Context,
    outside: string,
  ): Promise<void> {
    await rename(join(ctx.cwd, ".claude"), join(ctx.cwd, ".claude-moved"));
    await symlink(outside, join(ctx.cwd, ".claude"));
  }

  it("a .claude swapped for a symlink while the copy is classified never deletes outside the repository", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await outsideRepositoryCopy("commit", COMMIT);
    raceHooks.afterFingerprint.push(() => swapClaudeDirectoryFor(ctx, outside));

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(outside, "skills", COMMIT, "SKILL.md"))).toBe(true);
  });

  it("a .claude/skills swapped for a symlink while the copy is classified never deletes outside the repository", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await outsideRepositoryCopy("commit", COMMIT);
    raceHooks.afterFingerprint.push(async () => {
      await rename(
        join(ctx.cwd, ".claude/skills"),
        join(ctx.cwd, ".claude/skills-moved"),
      );
      await symlink(join(outside, "skills"), join(ctx.cwd, ".claude/skills"));
    });

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(outside, "skills", COMMIT, "SKILL.md"))).toBe(true);
  });

  it("a file added to the copy after it was classified is kept, under its own name", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    raceHooks.afterFingerprint.push(() =>
      writeFile(join(copy, "notes.md"), "mine\n"),
    );

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(copy, "notes.md"), "utf8")).toBe("mine\n");
    expect(await readdir(join(ctx.cwd, ".claude/skills"))).toEqual([COMMIT]);
  });

  it.skipIf(runningAsRoot)(
    "a failure after the copy was renamed names where agemon left it",
    async () => {
      const ctx = await createTestContext();
      await installCurrent(ctx, "commit", COMMIT);
      const claudeDirectory = join(ctx.cwd, ".claude");
      raceHooks.afterFingerprint.push(
        async () => undefined,
        () => chmod(claudeDirectory, 0o000),
      );
      try {
        await expect(skillsPlugin.uninstall(ctx)).rejects.toThrow(
          /agemon left the copy at \.claude\/skills\/\.agemon-removing-agemon-commit-[0-9a-f]{16}/u,
        );
      } finally {
        await chmod(claudeDirectory, 0o700);
      }
    },
  );

  it("a copy replaced by an identical directory after the parent is re-checked is kept", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    raceHooks.afterResolvingClaudeSkills.push(null, async () => {
      await rename(copy, join(ctx.cwd, "classified-copy"));
      await cp(join(ctx.cwd, "classified-copy"), copy, { recursive: true });
    });

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(copy, "SKILL.md"))).toBe(true);
    expect(ctx.infoLines).toContain(
      `Keeping .claude/skills/${COMMIT}: it changed while agemon was removing it.`,
    );
  });

  it("a .claude swapped for a symlink after the copy was renamed fails the removal and names the renamed copy", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await outsideRepositoryCopy("commit", COMMIT);
    raceHooks.afterResolvingClaudeSkills.push(null, null, () =>
      swapClaudeDirectoryFor(ctx, outside),
    );

    await expect(skillsPlugin.uninstall(ctx)).rejects.toThrow(
      /agemon left the copy at \.claude\/skills\/\.agemon-removing-agemon-commit-/u,
    );

    expect(existsSync(join(outside, "skills", COMMIT, "SKILL.md"))).toBe(true);
    const movedSkills = await readdir(join(ctx.cwd, ".claude-moved/skills"));
    expect(movedSkills).toHaveLength(1);
    expect(movedSkills[0]).toMatch(/^\.agemon-removing-agemon-commit-/u);
  });

  it("a .claude swapped for a symlink before a symlinked copy is unlinked leaves the outside link alone", async () => {
    const ctx = await createTestContext();
    const target = await writeSkill(join(ctx.cwd, "elsewhere", COMMIT));
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(target, join(ctx.cwd, ".claude/skills", COMMIT));
    await recordInstalled(ctx, COMMIT);
    const outside = await mkdtemp(join(tmpdir(), "agemon-skills-outside-"));
    createdTempDirectories.push(outside);
    await mkdir(join(outside, "skills"));
    await symlink(target, join(outside, "skills", COMMIT));
    raceHooks.afterResolvingClaudeSkills.push(() =>
      swapClaudeDirectoryFor(ctx, outside),
    );

    await skillsPlugin.uninstall(ctx);

    expect(
      (await lstat(join(outside, "skills", COMMIT))).isSymbolicLink(),
    ).toBe(true);
  });
});

describe("nuke and recorded install fingerprints of custom groups", () => {
  const REF = "a".repeat(40);
  const LINT_RULES = "lint-rules";
  const LINT_MANIFEST = "---\nname: lint-rules\n---\n\nrules\n";

  function withGithubGroup(ctx: NukeContext): NukeContext {
    return {
      ...ctx,
      customSkillGroups: [
        {
          id: "acme",
          label: "Acme",
          skills: [
            {
              kind: "github",
              owner: "acme",
              repository: "agent-skills",
              ref: REF,
              skillName: LINT_RULES,
            },
          ],
        },
      ],
    };
  }

  async function seedCachedCheckout(): Promise<string> {
    const checkout = resolvePinnedSkillsSourceDirectory(REF);
    await rm(checkout, { recursive: true, force: true });
    await mkdir(join(checkout, ".git"), { recursive: true });
    await writeSkill(join(checkout, "skills", LINT_RULES), LINT_MANIFEST);
    return checkout;
  }

  function gitAnswering(
    ctx: NukeContext,
    answers: { head: string; status: string },
  ): Context["run"] {
    return async (command, args, options) => {
      ctx.commands.push([command, ...args]);
      if (command === "git" && args.includes("rev-parse")) {
        return { code: 0, stdout: `${answers.head}\n`, stderr: "" };
      }
      if (command === "git" && args.includes("status")) {
        return { code: 0, stdout: answers.status, stderr: "" };
      }
      return runSubprocess(command, args, options);
    };
  }

  async function lintRulesCopy(ctx: NukeContext): Promise<string> {
    return writeSkill(
      join(ctx.cwd, ".claude/skills", LINT_RULES),
      LINT_MANIFEST,
    );
  }

  function gitCommands(ctx: NukeContext): string[][] {
    return ctx.commands.filter(([command]) => command === "git");
  }

  it("removes a copy that matches its recorded install fingerprint, running no git and no skills CLI", async () => {
    const ctx = withGithubGroup(await createTestContext());
    await seedCachedCheckout();
    const copy = await lintRulesCopy(ctx);
    await recordInstalled(
      ctx,
      LINT_RULES,
      await fingerprintInstalledSkill(copy),
    );
    ctx.run = gitAnswering(ctx, { head: REF, status: "" });

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(false);
    expect(gitCommands(ctx)).toEqual([]);
    expect(skillsCommands(ctx)).toEqual([]);
  });

  it("keeps a copy with no recorded fingerprint even when agemon's pristine cached checkout matches it, running no git", async () => {
    const ctx = withGithubGroup(await createTestContext());
    await seedCachedCheckout();
    const copy = await lintRulesCopy(ctx);
    await recordInstalled(ctx, LINT_RULES);
    ctx.run = gitAnswering(ctx, { head: REF, status: "" });

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(LINT_RULES));
    expect(gitCommands(ctx)).toEqual([]);
  });

  it("keeps a copy edited after its recorded install", async () => {
    const ctx = withGithubGroup(await createTestContext());
    const copy = await lintRulesCopy(ctx);
    await recordInstalled(
      ctx,
      LINT_RULES,
      await fingerprintInstalledSkill(copy),
    );
    await writeFile(join(copy, "SKILL.md"), "my edit\n");

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(LINT_RULES));
  });

  it("a fingerprint recorded for another skill does not authorize removal", async () => {
    const ctx = withGithubGroup(await createTestContext());
    const copy = await lintRulesCopy(ctx);
    await recordInstalled(ctx, LINT_RULES);
    await recordInstalled(ctx, COMMIT, await fingerprintInstalledSkill(copy));

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(true);
    expect(ctx.infoLines).toContain(keptLine(LINT_RULES));
  });
});

describe("skills CLI target checks", () => {
  it("checking targets for an add creates .claude/skills but never .agents/skills", async () => {
    const ctx = await createTestContext();

    await assertSkillsCliTargetsStayInRepo(ctx.cwd, [COMMIT], {
      create: true,
    });

    expect(existsSync(join(ctx.cwd, ".claude/skills"))).toBe(true);
    expect(existsSync(join(ctx.cwd, ".agents"))).toBe(false);
  });

  it("a symlinked .agents/skills/<name> still refuses an add", async () => {
    const ctx = await createTestContext();
    await mkdir(join(ctx.cwd, ".agents/skills"), { recursive: true });
    await symlink(tmpdir(), join(ctx.cwd, ".agents/skills", COMMIT));

    await expect(
      assertSkillsCliTargetsStayInRepo(ctx.cwd, [COMMIT], { create: true }),
    ).rejects.toThrow("is a symlink");
  });
});

describe("nuke never deletes .agents/skills", () => {
  it("keeps .agents/skills/<name> with user content and prints nothing about it", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeSkill(join(ctx.cwd, ".agents/skills", COMMIT), "user copy\n");

    await skillsPlugin.uninstall(ctx);

    expect(
      existsSync(join(ctx.cwd, ".agents/skills", COMMIT, "SKILL.md")),
    ).toBe(true);
    expect(ctx.infoLines.join("\n")).not.toContain(".agents/skills");
  });

  it("keeps a historical .agents/skills/<name> and prints the Left line", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const canonical = await writeSkill(join(ctx.cwd, ".agents/skills", COMMIT));
    shippedHistory.history[COMMIT] = [
      await fingerprintInstalledSkill(canonical),
    ];

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(canonical)).toBe(true);
    expect(ctx.infoLines).toContain(
      `Left .agents/skills/${COMMIT}: agemon's skills CLI no longer writes it; remove it if you no longer need it.`,
    );
  });

  it("a symlinked .agents or .agents/skills/<name> prints no Left line and is not followed", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await writeSkill(
      join(ctx.cwd, "outside-agents/skills", COMMIT),
    );
    shippedHistory.history[COMMIT] = [await fingerprintInstalledSkill(outside)];
    await symlink(join(ctx.cwd, "outside-agents"), join(ctx.cwd, ".agents"));

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
    expect(ctx.infoLines.join("\n")).not.toContain("Left .agents");
  });

  it("a symlinked .agents/skills/<name> in a real .agents/skills prints no Left line and is not followed", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    const outside = await writeSkill(join(ctx.cwd, "outside-copy", COMMIT));
    shippedHistory.history[COMMIT] = [await fingerprintInstalledSkill(outside)];
    await mkdir(join(ctx.cwd, ".agents/skills"), { recursive: true });
    await symlink(outside, join(ctx.cwd, ".agents/skills", COMMIT));

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(outside, "SKILL.md"))).toBe(true);
    expect(
      (await lstat(join(ctx.cwd, ".agents/skills", COMMIT))).isSymbolicLink(),
    ).toBe(true);
    expect(ctx.infoLines.join("\n")).not.toContain("Left .agents");
  });
});

describe("skills-lock.json on nuke and rollback", () => {
  it("the lock fixture was captured with the pinned skills CLI", () => {
    expect(LOCK_FIXTURE.cliVersion).toBe(TOOLS_MANIFEST.dependencies.skills);
  });

  it("a pre-existing user lock loses only agemon's keys, in the CLI's own format", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, "skills-lock.json"), LOCK_FIXTURE.lock);
    await installCurrent(ctx, "security", SECURITY);

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      LOCK_FIXTURE.afterRemovingAgemonSecurity,
    );
  });

  it("a user lock holding only agemon's key, with no record that agemon created it, is emptied and kept", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "security", SECURITY);
    await writeFile(
      join(ctx.cwd, "skills-lock.json"),
      `${JSON.stringify({ version: 1, skills: { [SECURITY]: { source: "x" } } }, null, 2)}\n`,
    );

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`,
    );
  });

  it("an edited, kept copy keeps its key, so agemon's own lock is kept too", async () => {
    const ctx = await createTestContext();
    const copy = await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(copy, "SKILL.md"), "my edit\n");
    const lock = `${JSON.stringify({ version: 1, skills: { [COMMIT]: {} } }, null, 2)}\n`;
    await writeFile(join(ctx.cwd, "skills-lock.json"), lock);
    await recordGeneratedLock(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copy)).toBe(true);
    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      lock,
    );
  });

  it("a removed skill named constructor that the lock does not list leaves the lock byte-identical", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, "constructor");
    const lock = '{"version":1,"skills":{"other":{}}}';
    await writeFile(join(ctx.cwd, "skills-lock.json"), lock);

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      lock,
    );
  });

  it("an oversized lock is kept and reported as too large", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeFile(
      join(ctx.cwd, "skills-lock.json"),
      Buffer.alloc(8 * 1024 * 1024 + 1, " "),
    );
    await recordGeneratedLock(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(ctx.cwd, "skills-lock.json"))).toBe(true);
    expect(ctx.infoLines).toContain(
      "Keeping skills-lock.json: it is too large for agemon to read (over 8 MiB).",
    );
  });

  it("agemon's lock is deleted once its last key is removed", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "security", SECURITY);
    await writeFile(
      join(ctx.cwd, "skills-lock.json"),
      `${JSON.stringify({ version: 1, skills: { [SECURITY]: {} } }, null, 2)}\n`,
    );
    await recordGeneratedLock(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(join(ctx.cwd, "skills-lock.json"))).toBe(false);
  });

  it("agemon's lock with a later user key keeps that key and the file, and nuke completes", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(ctx.cwd, "skills-lock.json"), LOCK_FIXTURE.lock);
    await recordGeneratedLock(ctx);
    await installCurrent(ctx, "security", SECURITY);

    await skillsPlugin.uninstall(ctx);

    expect(
      Object.keys(
        JSON.parse(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8"))
          .skills,
      ),
    ).toEqual(["writing-guidelines"]);
  });

  it("rollback of a second run removes only that run's keys from the first run's lock", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(ctx.cwd, "skills-lock.json"), LOCK_FIXTURE.lock);
    await recordGeneratedLock(ctx);
    const entriesBefore = ctx.manifest.getActions().length;
    await installCurrent(ctx, "security", SECURITY);
    const secondRunEntries = ctx.manifest.getActions().slice(entriesBefore);

    await skillsPlugin.revert?.(ctx, secondRunEntries);

    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      LOCK_FIXTURE.afterRemovingAgemonSecurity,
    );
    expect(existsSync(join(ctx.cwd, ".claude/skills", COMMIT))).toBe(true);
  });

  it("a __proto__ key and unknown fields survive the edit", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeFile(
      join(ctx.cwd, "skills-lock.json"),
      `{"version":1,"extra":{"kept":true},"skills":{"__proto__":{"a":1},"${COMMIT}":{},"other":{"note":"x"}}}\n`,
    );

    await skillsPlugin.uninstall(ctx);

    const edited = await readFile(join(ctx.cwd, "skills-lock.json"), "utf8");
    expect(edited).toContain('"__proto__"');
    expect(edited).toContain('"extra"');
    expect(edited).toContain('"other"');
    expect(edited).not.toContain(COMMIT);
  });

  it.each([
    ["version 2", '{"version":2,"skills":{"agemon-commit":{}}}\n'],
    ["unparseable JSON", "{not json\n"],
    ["skills that is not an object", '{"version":1,"skills":[]}\n'],
  ])(
    "a lock with %s is kept unchanged and reported",
    async (_label, contents) => {
      const ctx = await createTestContext();
      await installCurrent(ctx, "commit", COMMIT);
      await writeFile(join(ctx.cwd, "skills-lock.json"), contents);
      await recordGeneratedLock(ctx);

      await skillsPlugin.uninstall(ctx);

      expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
        contents,
      );
      expect(ctx.infoLines).toContain(
        `skills-lock.json has a format agemon doesn't know; it may still list ${COMMIT}.`,
      );
    },
  );

  it("a symlinked lock is kept and reported", async () => {
    const ctx = await createTestContext();
    await installCurrent(ctx, "commit", COMMIT);
    await writeFile(join(ctx.cwd, "elsewhere.json"), LOCK_FIXTURE.lock);
    await symlink(
      join(ctx.cwd, "elsewhere.json"),
      join(ctx.cwd, "skills-lock.json"),
    );
    await recordGeneratedLock(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(ctx.cwd, "elsewhere.json"), "utf8")).toBe(
      LOCK_FIXTURE.lock,
    );
    expect(ctx.infoLines).toContain(
      "Keeping skills-lock.json: it is not a regular file.",
    );
  });

  it.skipIf(runningAsRoot)(
    "a skill whose removal failed keeps its key and nuke reports the failure",
    async () => {
      const ctx = await createTestContext();
      const copy = await installCurrent(ctx, "commit", COMMIT);
      await writeFile(join(ctx.cwd, "skills-lock.json"), LOCK_FIXTURE.lock);
      await chmod(copy, 0o500);
      try {
        await expect(skillsPlugin.uninstall(ctx)).rejects.toThrow(
          `.claude/skills/${COMMIT}`,
        );
      } finally {
        await chmod(copy, 0o700);
      }

      expect(
        await readFile(join(ctx.cwd, "skills-lock.json"), "utf8"),
      ).toContain(COMMIT);
    },
  );

  it("dry run says which keys it would remove and whether it would delete the lock", async () => {
    const ctx = await createTestContext(true);
    await installCurrent(ctx, "security", SECURITY);
    await writeFile(join(ctx.cwd, "skills-lock.json"), LOCK_FIXTURE.lock);

    await skillsPlugin.uninstall(ctx);

    expect(ctx.infoLines).toContain(
      `Would remove ${SECURITY} from skills-lock.json`,
    );
    expect(await readFile(join(ctx.cwd, "skills-lock.json"), "utf8")).toBe(
      LOCK_FIXTURE.lock,
    );
  });
});
