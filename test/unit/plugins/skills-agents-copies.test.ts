import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import { fingerprintInstalledSkill } from "../../../src/plugins/skills/skill-tree.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  multiselect: async () => [],
}));

const shippedHistory = vi.hoisted(() => ({
  history: {} as Record<string, string[]>,
}));

vi.mock("../../../src/plugins/skills/bundle-fingerprints.js", () => ({
  BUNDLE_FINGERPRINTS: shippedHistory,
}));

const treeReads = vi.hoisted(() => ({
  beforeRead: [] as Array<() => Promise<void>>,
}));

vi.mock("../../../src/plugins/skills/skill-tree.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/plugins/skills/skill-tree.js")
    >();
  return {
    ...actual,
    readInstalledSkill: async (directory: string) => {
      const entries = await actual.readInstalledSkill(directory);
      await treeReads.beforeRead.shift()?.();
      return entries;
    },
  };
});

const COMMIT = "agemon-commit";
const COPY_ACTION_TYPE = "installed-agents-skill-copy";
const TEAM_COPY = "---\nname: agemon-commit\n---\n\nthe team's own copy\n";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
  resetFakeSubprocessState();
  shippedHistory.history = {};
  treeReads.beforeRead = [];
});

interface CopiesContext extends Context {
  infoLines: string[];
}

async function createContext(
  options: {
    onPath?: string[];
    groups?: string[];
    dryRun?: boolean;
    cwd?: string;
  } = {},
): Promise<CopiesContext> {
  const cwd =
    options.cwd ?? (await mkdtemp(join(tmpdir(), "agemon-agents-copies-")));
  createdTempDirectories.push(cwd);
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  const infoLines: string[] = [];
  const onPath = options.onPath ?? ["codex"];
  return {
    infoLines,
    cwd,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: options.dryRun ?? false,
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
    run: runSubprocess,
    manifest: await StateManifest.load(cwd),
    serviceManager: {} as ServiceManager,
    verifiedBinaryInstaller: {
      install: async () => {},
      installLinked: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
    requestedSkillGroupIds: new Set(options.groups ?? ["commit"]),
    isExecutableOnPath: async (name) => onPath.includes(name),
  };
}

function plan(ctx: Context): Promise<ProposedOperation[]> {
  return (skillsPlugin.plan as NonNullable<typeof skillsPlugin.plan>)(ctx);
}

async function applyAll(ctx: Context): Promise<ProposedOperation[]> {
  const operations = await plan(ctx);
  await (skillsPlugin.apply as NonNullable<typeof skillsPlugin.apply>)(
    ctx,
    operations,
  );
  return operations;
}

function copyOperations(operations: ProposedOperation[]): ProposedOperation[] {
  return operations.filter((operation) => operation.action === "copy-skills");
}

function previewOf(operation: ProposedOperation | undefined): string {
  return operation?.preview.kind === "note" ? operation.preview.text : "";
}

function copyPath(ctx: Context, name = COMMIT): string {
  return join(ctx.cwd, ".agents/skills", name);
}

function claudePath(ctx: Context, name = COMMIT): string {
  return join(ctx.cwd, ".claude/skills", name);
}

function copyRecords(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((action) => action.type === COPY_ACTION_TYPE);
}

async function writeSkillAt(directory: string, contents: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), contents);
}

describe("deciding when .agents/skills is needed", () => {
  it("offers nothing when no agent needs the directory", async () => {
    const ctx = await createContext({ onPath: ["claude", "cursor"] });

    await applyAll(ctx);

    expect(existsSync(claudePath(ctx))).toBe(true);
    expect(existsSync(join(ctx.cwd, ".agents"))).toBe(false);
  });

  it("does not offer it to a run that cannot look at PATH", async () => {
    const ctx = await createContext();
    ctx.isExecutableOnPath = undefined;

    expect(copyOperations(await plan(ctx))).toEqual([]);
  });

  it.each(["codex", "gemini", "antigravity", "agy", "devin"])(
    "offers it when %s is on PATH",
    async (binary) => {
      const ctx = await createContext({ onPath: [binary] });

      expect(copyOperations(await plan(ctx))).toHaveLength(1);
    },
  );

  it.each([".codex", ".gemini", ".devin"])(
    "offers it when the repository has %s",
    async (marker) => {
      const ctx = await createContext({ onPath: [] });
      await mkdir(join(ctx.cwd, marker));

      expect(copyOperations(await plan(ctx))).toHaveLength(1);
    },
  );

  it("asks for consent and names the target and the skills", async () => {
    const ctx = await createContext();

    const [operation] = copyOperations(await plan(ctx));

    expect(operation.requiresConsent).toBe(true);
    expect(operation.targetPath).toBe(".agents/skills");
    expect(previewOf(operation)).toContain(COMMIT);
  });
});

describe("copying into .agents/skills", () => {
  it("records each copy with the hash of what it wrote", async () => {
    const ctx = await createContext();

    await applyAll(ctx);

    expect(copyRecords(ctx)).toEqual([
      expect.objectContaining({
        plugin: "skills",
        target: COMMIT,
        preExisting: false,
        fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx)),
      }),
    ]);
  });

  it("records the directories it created so nuke can remove them", async () => {
    const ctx = await createContext();

    await applyAll(ctx);

    const created = ctx.manifest
      .getActions()
      .filter((action) => action.type === "created-directory")
      .map((action) => action.target);
    expect(created).toEqual(
      expect.arrayContaining([".agents", ".agents/skills"]),
    );
  });

  it("writes portable frontmatter and leaves the Claude copy as shipped", async () => {
    const ctx = await createContext({ groups: ["design"] });

    await applyAll(ctx);

    const portable = await readFile(
      join(copyPath(ctx, "agemon-design"), "SKILL.md"),
      "utf8",
    );
    const claude = await readFile(
      join(claudePath(ctx, "agemon-design"), "SKILL.md"),
      "utf8",
    );
    expect(portable).toContain("metadata:\n  argument-hint:");
    expect(portable).not.toMatch(/^argument-hint:/mu);
    expect(claude).toMatch(/^argument-hint:/mu);
    expect(existsSync(join(copyPath(ctx, "agemon-design"), "LICENSE"))).toBe(
      true,
    );
  });

  it("does not copy a skill meant to run only by name, and says so", async () => {
    const ctx = await createContext({ groups: ["output-style", "commit"] });

    const operations = await applyAll(ctx);

    expect(existsSync(claudePath(ctx, "agemon-adhd"))).toBe(true);
    expect(existsSync(copyPath(ctx, "agemon-adhd"))).toBe(false);
    expect(previewOf(copyOperations(operations)[0])).toContain(
      "agemon-adhd — not copied",
    );
  });

  it("reports a skill it would not copy even when nothing else is offered", async () => {
    const ctx = await createContext({ groups: ["output-style"] });

    expect(copyOperations(await applyAll(ctx))).toEqual([]);

    expect(await skillsPlugin.describeState?.(ctx)).toContainEqual(
      expect.objectContaining({
        resourceId: "agents-skills:copies",
        detail: expect.stringContaining("agemon-adhd not copied"),
      }),
    );
  });

  it("does not spread an edited Claude copy", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await rm(copyPath(ctx), { recursive: true });
    await writeSkillAt(
      claudePath(ctx),
      "---\nname: agemon-commit\n---\nmine\n",
    );

    const operations = await applyAll(ctx);

    expect(existsSync(copyPath(ctx))).toBe(false);
    expect(copyOperations(operations)).toEqual([]);
  });

  it("is quiet once every copy is current", async () => {
    const ctx = await createContext();
    await applyAll(ctx);

    ctx.requestedSkillGroupIds = undefined;

    expect(copyOperations(await plan(ctx))).toEqual([]);
  });

  it("offers a copy for skills already installed when an agent appears later", async () => {
    const ctx = await createContext({ onPath: [] });
    await applyAll(ctx);
    expect(existsSync(copyPath(ctx))).toBe(false);

    const later = await createContext({ cwd: ctx.cwd, onPath: ["codex"] });
    later.requestedSkillGroupIds = undefined;
    await applyAll(later);

    expect(existsSync(copyPath(later))).toBe(true);
  });
});

describe("a copy agemon did not write", () => {
  it("is never overwritten and is reported", async () => {
    const ctx = await createContext();
    await writeSkillAt(copyPath(ctx), TEAM_COPY);

    await applyAll(ctx);

    expect(await readFile(join(copyPath(ctx), "SKILL.md"), "utf8")).toBe(
      TEAM_COPY,
    );
    expect(copyRecords(ctx)).toEqual([]);
    const rows = await skillsPlugin.describeState?.(ctx);
    expect(rows).toContainEqual(
      expect.objectContaining({
        resourceId: "agents-skills:copies",
        state: "present-modified",
        detail: expect.stringContaining(COMMIT),
      }),
    );
  });

  it("is never deleted by nuke", async () => {
    const ctx = await createContext();
    await writeSkillAt(copyPath(ctx), TEAM_COPY);
    await applyAll(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(await readFile(join(copyPath(ctx), "SKILL.md"), "utf8")).toBe(
      TEAM_COPY,
    );
  });

  it("is a conflict when it arrives between plan and apply", async () => {
    const ctx = await createContext();
    const operations = await plan(ctx);
    await writeSkillAt(copyPath(ctx), TEAM_COPY);

    await (skillsPlugin.apply as NonNullable<typeof skillsPlugin.apply>)(
      ctx,
      operations,
    );

    expect(await readFile(join(copyPath(ctx), "SKILL.md"), "utf8")).toBe(
      TEAM_COPY,
    );
    expect(copyRecords(ctx)).toEqual([]);
  });

  it("treats a symlink as a conflict and leaves its target alone", async () => {
    const ctx = await createContext();
    const outside = join(ctx.cwd, "outside");
    await writeSkillAt(outside, TEAM_COPY);
    await mkdir(join(ctx.cwd, ".agents/skills"), { recursive: true });
    await symlink(outside, copyPath(ctx));

    expect(copyOperations(await plan(ctx))).toEqual([]);
    expect((await lstat(copyPath(ctx))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(TEAM_COPY);
  });

  it("refuses to write through a symlinked .agents/skills", async () => {
    const ctx = await createContext();
    const outside = join(ctx.cwd, "outside");
    await mkdir(outside);
    await mkdir(join(ctx.cwd, ".agents"));
    await symlink(outside, join(ctx.cwd, ".agents/skills"));

    await expect(applyAll(ctx)).rejects.toThrow(/symlink/u);

    expect(existsSync(join(outside, COMMIT))).toBe(false);
  });
});

describe("nuke", () => {
  it("removes a recorded, unchanged copy and its record", async () => {
    const ctx = await createContext();
    await applyAll(ctx);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copyPath(ctx))).toBe(false);
    expect(existsSync(claudePath(ctx))).toBe(false);
    expect(ctx.infoLines.join("\n")).not.toContain("Left .agents");
  });

  it("keeps and names a copy changed after install", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await writeFile(join(copyPath(ctx), "SKILL.md"), TEAM_COPY);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copyPath(ctx))).toBe(true);
    expect(ctx.infoLines.join("\n")).toContain(
      `Keeping .agents/skills/${COMMIT}: it differs from what agemon wrote`,
    );
  });

  it("keeps a copy whose ledger record this machine cannot confirm", async () => {
    const ctx = await createContext();
    await writeSkillAt(copyPath(ctx), TEAM_COPY);
    const fingerprint = await fingerprintInstalledSkill(copyPath(ctx));
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: COPY_ACTION_TYPE,
        target: COMMIT,
        preExisting: false,
        fingerprintAfter: fingerprint,
      },
    ]);

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copyPath(ctx))).toBe(true);
  });

  it("removes nothing in a dry run and names the copy", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    ctx.dryRun = true;

    await skillsPlugin.uninstall(ctx);

    expect(existsSync(copyPath(ctx))).toBe(true);
    expect(ctx.infoLines).toContain(`Would remove .agents/skills/${COMMIT}`);
  });
});

describe("reading the Claude copy", () => {
  it("copies a skill with Finder metadata beside it", async () => {
    const ctx = await createContext({ onPath: [] });
    await applyAll(ctx);
    await writeFile(join(claudePath(ctx), ".DS_Store"), "finder");

    const later = await createContext({ cwd: ctx.cwd });
    later.requestedSkillGroupIds = undefined;
    await applyAll(later);

    expect(existsSync(join(copyPath(later), "SKILL.md"))).toBe(true);
    expect(existsSync(join(copyPath(later), ".DS_Store"))).toBe(false);
  });

  it("never writes through a source swapped for a symlink mid-copy", async () => {
    const ctx = await createContext({ onPath: [] });
    await applyAll(ctx);
    const victim = join(ctx.cwd, "victim");
    await writeSkillAt(victim, "original\n");
    const later = await createContext({ cwd: ctx.cwd });
    later.requestedSkillGroupIds = undefined;
    const operations = await plan(later);

    const swapSource = async () => {
      await rm(claudePath(later), { recursive: true });
      await symlink(victim, claudePath(later));
    };
    treeReads.beforeRead = [async () => {}, swapSource];
    await (skillsPlugin.apply as NonNullable<typeof skillsPlugin.apply>)(
      later,
      operations,
    );

    expect(await readFile(join(victim, "SKILL.md"), "utf8")).toBe("original\n");
    const leftovers = await readdir(join(later.cwd, ".agents/skills"));
    expect(leftovers.filter((name) => name.startsWith(".agemon"))).toEqual([]);
  });

  it("keeps an executable script executable in the copy", async () => {
    const ctx = await createContext({ onPath: [] });
    await applyAll(ctx);
    const script = join(claudePath(ctx), "run.sh");
    await writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: COMMIT,
      preExisting: false,
      fingerprintAfter: await fingerprintInstalledSkill(claudePath(ctx)),
    });

    const later = await createContext({ cwd: ctx.cwd });
    later.requestedSkillGroupIds = undefined;
    await applyAll(later);

    expect((await lstat(join(copyPath(later), "run.sh"))).mode & 0o111).toBe(
      0o111,
    );
  });
});

describe("when a Claude copy is missing but .agents/skills has one", () => {
  it("installs the Claude copy after nuke kept a changed copy", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await writeFile(join(copyPath(ctx), "SKILL.md"), TEAM_COPY);
    await skillsPlugin.uninstall(ctx);
    await ctx.manifest.removeActionIds(copyRecords(ctx).map(({ id }) => id));

    await applyAll(ctx);

    expect(existsSync(claudePath(ctx))).toBe(true);
    expect(await readFile(join(copyPath(ctx), "SKILL.md"), "utf8")).toBe(
      TEAM_COPY,
    );
  });
});

describe("a bundled update", () => {
  it("updates the copy in the same run as the Claude copy", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    const current = await fingerprintInstalledSkill(copyPath(ctx));
    await writeFile(
      join(claudePath(ctx), "SKILL.md"),
      "---\nname: agemon-commit\n---\nold\n",
    );
    await rm(copyPath(ctx), { recursive: true });
    await writeSkillAt(copyPath(ctx), "---\nname: agemon-commit\n---\nold\n");
    await ctx.manifest.removeActionIds(copyRecords(ctx).map(({ id }) => id));
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: COPY_ACTION_TYPE,
      target: COMMIT,
      preExisting: false,
      fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx)),
    });
    shippedHistory.history[COMMIT] = [
      await fingerprintInstalledSkill(claudePath(ctx)),
    ];
    ctx.requestedSkillGroupIds = undefined;

    const operations = await applyAll(ctx);

    expect(copyOperations(operations)).toHaveLength(1);
    expect(await fingerprintInstalledSkill(copyPath(ctx))).toBe(current);
  });
});

describe("first-time copies need a decision", () => {
  function unattended(ctx: CopiesContext): CopiesContext {
    ctx.yes = false;
    ctx.interactive = false;
    return ctx;
  }

  it("does not plan them for an unattended run without --yes", async () => {
    const ctx = await createContext({ onPath: [] });
    await applyAll(ctx);
    const later = unattended(await createContext({ cwd: ctx.cwd }));
    later.requestedSkillGroupIds = undefined;

    expect(copyOperations(await plan(later))).toEqual([]);
    expect(await skillsPlugin.describeState?.(later)).toContainEqual(
      expect.objectContaining({
        resourceId: "agents-skills:copies",
        state: "absent",
        detail: expect.stringContaining("Codex"),
      }),
    );
  });

  it("still plans updates to existing copies without --yes", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await writeFile(join(copyPath(ctx), "SKILL.md"), TEAM_COPY);
    await ctx.manifest.removeActionIds(copyRecords(ctx).map(({ id }) => id));
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: COPY_ACTION_TYPE,
      target: COMMIT,
      preExisting: false,
      fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx)),
    });
    ctx.requestedSkillGroupIds = undefined;

    expect(copyOperations(await plan(unattended(ctx)))).toHaveLength(1);
  });

  describe("in an interactive run", () => {
    async function interactiveContext(answer: boolean) {
      const ctx = await createContext({ onPath: [] });
      await applyAll(ctx);
      const later = await createContext({ cwd: ctx.cwd });
      later.requestedSkillGroupIds = undefined;
      later.yes = false;
      later.interactive = true;
      later.confirm = async () => answer;
      return later;
    }

    it("plans them when the person agrees", async () => {
      const ctx = await interactiveContext(true);

      expect(copyOperations(await plan(ctx))).toHaveLength(1);
    });

    it("remembers a decline, even for a later --yes", async () => {
      const ctx = await interactiveContext(false);

      await applyAll(ctx);
      expect(existsSync(copyPath(ctx))).toBe(false);

      ctx.yes = true;
      ctx.interactive = false;
      expect(copyOperations(await plan(ctx))).toEqual([]);
      expect(await skillsPlugin.describeState?.(ctx)).toContainEqual(
        expect.objectContaining({
          resourceId: "agents-skills:copies",
          state: "declined",
        }),
      );
    });

    it("asks again when a skill group is requested by name", async () => {
      const ctx = await interactiveContext(false);
      await applyAll(ctx);

      ctx.yes = true;
      ctx.interactive = false;
      ctx.requestedSkillGroupIds = new Set(["commit"]);
      await applyAll(ctx);

      expect(existsSync(copyPath(ctx))).toBe(true);
      ctx.requestedSkillGroupIds = undefined;
      expect(await skillsPlugin.describeState?.(ctx)).toContainEqual(
        expect.objectContaining({
          resourceId: "agents-skills:copies",
          state: "present-managed",
        }),
      );
    });
  });
});

describe("verify", () => {
  it("names a changed copy on its own line", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await writeFile(join(copyPath(ctx), "SKILL.md"), TEAM_COPY);

    await skillsPlugin.verify(ctx);

    expect(ctx.infoLines).toContain(
      `skills: agemon keeps .agents/skills/${COMMIT} (changed since agemon wrote it); delete it and run agemon to get agemon's copy`,
    );
  });
});

describe("updates", () => {
  async function withStaleCopy(): Promise<CopiesContext> {
    const ctx = await createContext();
    await applyAll(ctx);
    await writeFile(join(copyPath(ctx), "SKILL.md"), TEAM_COPY);
    const [record] = copyRecords(ctx);
    await ctx.manifest.removeActionIds([record.id]);
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: COPY_ACTION_TYPE,
      target: COMMIT,
      preExisting: false,
      fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx)),
    });
    ctx.requestedSkillGroupIds = undefined;
    return ctx;
  }

  it("replaces an unchanged older copy and keeps one record", async () => {
    const ctx = await withStaleCopy();

    await applyAll(ctx);

    const contents = await readFile(join(copyPath(ctx), "SKILL.md"), "utf8");
    expect(contents).not.toBe(TEAM_COPY);
    expect(copyRecords(ctx)).toEqual([
      expect.objectContaining({
        fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx)),
      }),
    ]);
  });

  it("leaves a copy changed since it was recorded", async () => {
    const ctx = await withStaleCopy();
    await writeFile(join(copyPath(ctx), "SKILL.md"), "edited by hand\n");

    await applyAll(ctx);

    expect(await readFile(join(copyPath(ctx), "SKILL.md"), "utf8")).toBe(
      "edited by hand\n",
    );
  });
});

describe("the Claude copy and its .agents/skills copy", () => {
  it("reinstalls a deleted Claude copy even though the owned copy remains", async () => {
    const ctx = await createContext();
    await applyAll(ctx);
    await rm(claudePath(ctx), { recursive: true });
    ctx.requestedSkillGroupIds = undefined;

    await applyAll(ctx);

    expect(existsSync(claudePath(ctx))).toBe(true);
  });

  it("removes the owned copy when its skill is retired", async () => {
    const ctx = await createContext({ onPath: ["codex"] });
    const retired = "agemon-design-minimal";
    await cp(
      resolveVendoredSkillPath("commit", COMMIT),
      claudePath(ctx, retired),
      {
        recursive: true,
      },
    );
    const claudeFingerprint = await fingerprintInstalledSkill(
      claudePath(ctx, retired),
    );
    await writeSkillAt(copyPath(ctx, retired), TEAM_COPY);
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: retired,
      preExisting: false,
      fingerprintAfter: claudeFingerprint,
    });
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: COPY_ACTION_TYPE,
      target: retired,
      preExisting: false,
      fingerprintAfter: await fingerprintInstalledSkill(copyPath(ctx, retired)),
    });
    ctx.requestedSkillGroupIds = new Set();

    await applyAll(ctx);

    expect(existsSync(claudePath(ctx, retired))).toBe(false);
    expect(existsSync(copyPath(ctx, retired))).toBe(false);
  });
});
