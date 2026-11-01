import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import {
  ensureGitignoreEntry,
  writeAgemonGitignoreEntry,
} from "../../../src/core/gitignore.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { ensureRepoDirectory } from "../../../src/core/repo-paths.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  recordCreatedDirectories,
  recordGitignoreLine,
  WORKSPACE_PLUGIN_ID,
} from "../../../src/core/workspace-footprint.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import type { AgemonPlugin } from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface FootprintContext extends Context {
  infoLines: string[];
}

async function createTestContext(): Promise<FootprintContext> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-footprint-"));
  createdTempDirectories.push(cwd);
  const infoLines: string[] = [];
  const record = (line: string) => {
    infoLines.push(line);
  };
  return {
    infoLines,
    cwd,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    confirm: async () => true,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: { log: record, error: record },
    ui: { start() {}, succeed() {}, fail() {}, info: record },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(cwd),
    serviceManager: {} as ServiceManager,
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

function standInCapability(id: string): AgemonPlugin {
  return {
    id,
    async detect() {
      return { present: true, preExisting: false };
    },
    async install() {},
    async verify() {
      return { ok: true };
    },
    async uninstall() {},
  };
}

const ALPHA = standInCapability("alpha");
const BETA = standInCapability("beta");

async function recordCapabilityEntry(ctx: Context, id: string): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: id,
    type: "thing",
    target: `${id}.txt`,
    preExisting: false,
  });
}

async function addAgemonLine(ctx: Context): Promise<void> {
  await recordGitignoreLine(
    ctx,
    "/.agemon/",
    await writeAgemonGitignoreEntry(ctx.cwd),
  );
}

async function addSkillsLockLine(ctx: Context): Promise<void> {
  await recordGitignoreLine(
    ctx,
    "/skills-lock.json",
    await ensureGitignoreEntry(ctx.cwd, "/skills-lock.json"),
  );
}

async function createRecordedDirectory(
  ctx: Context,
  directory: string,
): Promise<void> {
  await recordCreatedDirectories(
    ctx,
    await ensureRepoDirectory(ctx.cwd, directory),
  );
}

async function gitignoreOf(ctx: Context): Promise<string | null> {
  return existsSync(join(ctx.cwd, ".gitignore"))
    ? readFile(join(ctx.cwd, ".gitignore"), "utf8")
    : null;
}

async function appendToGitignore(ctx: Context, text: string): Promise<void> {
  await writeFile(
    join(ctx.cwd, ".gitignore"),
    `${(await gitignoreOf(ctx)) ?? ""}${text}`,
  );
}

function workspaceEntries(ctx: Context) {
  return ctx.manifest
    .getActions()
    .filter((entry) => entry.plugin === WORKSPACE_PLUGIN_ID);
}

describe("recording the workspace footprint", () => {
  it("records a gitignore-line entry only when the line was added, with the line in the resource id", async () => {
    const ctx = await createTestContext();

    await addAgemonLine(ctx);
    await addAgemonLine(ctx);

    expect(
      workspaceEntries(ctx).map(({ type, target, resourceId }) => ({
        type,
        target,
        resourceId,
      })),
    ).toEqual([
      {
        type: "gitignore-line",
        target: ".gitignore",
        resourceId: "gitignore-line:/.agemon/",
      },
    ]);
  });

  it("records only allowlisted lines", async () => {
    const ctx = await createTestContext();

    await recordGitignoreLine(
      ctx,
      "/src/",
      await ensureGitignoreEntry(ctx.cwd, "/src/"),
    );

    expect(workspaceEntries(ctx)).toEqual([]);
  });

  it("records only allowlisted directories", async () => {
    const ctx = await createTestContext();

    await recordCreatedDirectories(ctx, [".claude", "src", ".agents/skills"]);

    expect(workspaceEntries(ctx).map((entry) => entry.resourceId)).toEqual([
      "created-directory:.claude",
    ]);
  });
});

describe("nuke and agemon's .gitignore lines", () => {
  it("deletes a .gitignore agemon created once it ends up empty", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await addSkillsLockLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBeNull();
    expect(existsSync(join(ctx.cwd, ".agemon"))).toBe(false);
  });

  it("restores the original bytes, including a missing final newline", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "node_modules");
    await addAgemonLine(ctx);
    await addSkillsLockLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("node_modules");
  });

  it("keeps an empty .gitignore the user owned", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "");
    await addAgemonLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("");
  });

  it("restores CRLF line endings", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "dist\r\n");
    await addAgemonLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("dist\r\n");
  });

  it("keeps user lines added after install and a user's equivalent .agemon line", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), ".agemon\n!.agemon\n");
    await addAgemonLine(ctx);
    await appendToGitignore(ctx, "coverage/\n");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe(".agemon\n!.agemon\ncoverage/\n");
  });

  it("keeps equivalent lines the user added after agemon's line", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await appendToGitignore(ctx, "/.agemon\n.agemon\n.agemon/\n");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon\n.agemon\n.agemon/\n");
  });

  it("a .gitignore with /.agemon/ and a later !.agemon round-trips to the original bytes", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "/.agemon/\n!.agemon\n");
    await addAgemonLine(ctx);
    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n!.agemon\n/.agemon/\n");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n!.agemon\n");
  });

  it("removes two recorded /.agemon/ lines newest first, and the user's identical earlier line survives", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "/.agemon/\n!.agemon\n");
    await addAgemonLine(ctx);
    await appendToGitignore(ctx, "!.agemon\n");
    await addAgemonLine(ctx);
    expect(await gitignoreOf(ctx)).toBe(
      "/.agemon/\n!.agemon\n/.agemon/\n!.agemon\n/.agemon/\n",
    );
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n!.agemon\n!.agemon\n");
  });

  it("undoes each recorded separator newest first", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "a");
    await addAgemonLine(ctx);
    await appendToGitignore(ctx, "!.agemon");
    await addAgemonLine(ctx);
    expect(await gitignoreOf(ctx)).toBe("a\n/.agemon/\n!.agemon\n/.agemon/\n");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("a\n!.agemon");
  });

  it("keeps later user lines that differ from agemon's only by whitespace or a lone CR", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "dist\n");
    await addAgemonLine(ctx);
    await appendToGitignore(ctx, "/.agemon/ \n/.agemon/\r");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("dist\n/.agemon/ \n/.agemon/\r");
  });

  it("keeps a symlinked .gitignore and says so", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await writeFile(join(ctx.cwd, "real-ignore"), "/.agemon/\n");
    await rm(join(ctx.cwd, ".gitignore"));
    await symlink(join(ctx.cwd, "real-ignore"), join(ctx.cwd, ".gitignore"));
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await readFile(join(ctx.cwd, "real-ignore"), "utf8")).toBe(
      "/.agemon/\n",
    );
    expect(ctx.infoLines).toContain(
      "Keeping /.agemon/ in .gitignore: .gitignore is not a regular file.",
    );
  });

  it("keeps the /skills-lock.json line while skills-lock.json exists", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await addSkillsLockLine(ctx);
    await writeFile(join(ctx.cwd, "skills-lock.json"), "{}\n");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/skills-lock.json\n");
    expect(ctx.infoLines).toContain(
      "Keeping /skills-lock.json in .gitignore: skills-lock.json still exists",
    );
    expect(ctx.infoLines.some((line) => line.startsWith("Left "))).toBe(false);
  });

  it("removes the /.agemon/ line only after .agemon/ is gone", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");
    vi.spyOn(ctx.manifest, "pruneIfEmpty").mockResolvedValue();

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n");
    expect(ctx.infoLines).toContain(
      "Keeping /.agemon/ in .gitignore: .agemon/ still exists",
    );
  });

  it("keeps the lines while another capability is still recorded", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await recordCapabilityEntry(ctx, "alpha");
    await recordCapabilityEntry(ctx, "beta");

    await uninstallPlugins({ ...ctx, yes: false }, [ALPHA, BETA], {
      only: ["alpha"],
    });
    await uninstallPlugins({ ...ctx, dryRun: true }, [ALPHA, BETA], {
      only: ["alpha"],
    });
    await uninstallPlugins(ctx, [ALPHA, BETA], { only: ["alpha"] });

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n");
    expect(workspaceEntries(ctx)).toHaveLength(1);
    expect(ctx.infoLines.join("\n")).not.toContain("remove from .gitignore");
  });

  it("does not report a claim for a line a confirmed entry also names, and removes that line", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await appendLedgerClaims(ctx, [
      {
        plugin: WORKSPACE_PLUGIN_ID,
        type: "gitignore-line",
        target: ".gitignore",
        resourceId: "gitignore-line:/.agemon/",
        preExisting: false,
      },
    ]);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBeNull();
    expect(ctx.infoLines.some((line) => line.startsWith("Keeping "))).toBe(
      false,
    );
  });

  it("reports and drops a claim workspace entry, keeping its line", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "/.agemon/\n");
    await appendLedgerClaims(ctx, [
      {
        plugin: WORKSPACE_PLUGIN_ID,
        type: "gitignore-line",
        target: ".gitignore",
        resourceId: "gitignore-line:/.agemon/",
        preExisting: false,
      },
    ]);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n");
    expect(ctx.infoLines).toContain(
      "Keeping /.agemon/ in .gitignore: agemon has no record on this machine that it added it.",
    );
    expect(existsSync(join(ctx.cwd, ".agemon"))).toBe(false);
  });

  it("ignores a recorded line outside the allowlist", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "/src/\n");
    await ctx.manifest.recordAction({
      plugin: WORKSPACE_PLUGIN_ID,
      type: "gitignore-line",
      target: ".gitignore",
      resourceId: "gitignore-line:/src/",
      preExisting: true,
    });
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/src/\n");
    expect(existsSync(join(ctx.cwd, ".agemon"))).toBe(false);
  });

  it("gives a legacy repository without footprint entries the Left hint", async () => {
    const ctx = await createTestContext();
    await writeFile(
      join(ctx.cwd, ".gitignore"),
      "/.agemon/\n/skills-lock.json\n",
    );
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n/skills-lock.json\n");
    expect(ctx.infoLines).toContain(
      "Left /.agemon/ and /skills-lock.json in .gitignore: agemon has no record of adding them. Remove them if you no longer need them.",
    );
  });

  it("previews the footprint before asking, and a dry run prints it and changes nothing", async () => {
    const ctx = await createTestContext();
    await addAgemonLine(ctx);
    await createRecordedDirectory(ctx, ".claude/skills");
    await recordCapabilityEntry(ctx, "alpha");
    const ledgerBefore = ctx.manifest.getActions();

    expect(await uninstallPlugins({ ...ctx, yes: false }, [ALPHA], {})).toBe(
      "previewed",
    );
    await uninstallPlugins({ ...ctx, dryRun: true }, [ALPHA], {});

    expect(await gitignoreOf(ctx)).toBe("/.agemon/\n");
    expect(existsSync(join(ctx.cwd, ".claude/skills"))).toBe(true);
    expect(ctx.manifest.getActions()).toEqual(ledgerBefore);
    const preview = ctx.infoLines.join("\n");
    expect(preview).toContain(
      "  remove empty directories agemon created: .claude/skills, .claude",
    );
    expect(preview).toContain(
      "  remove from .gitignore: /.agemon/ (added by agemon)",
    );
    expect(ctx.infoLines).toContain(
      "Would remove empty directories agemon created: .claude/skills, .claude",
    );
    expect(ctx.infoLines).toContain(
      "Would remove from .gitignore: /.agemon/ (added by agemon)",
    );
  });
});

describe("nuke and the empty directories agemon created", () => {
  it("removes recorded empty directories deepest first on every nuke and keeps non-empty ones", async () => {
    const ctx = await createTestContext();
    await createRecordedDirectory(ctx, ".claude/skills");
    await createRecordedDirectory(ctx, ".claude/agents");
    await writeFile(join(ctx.cwd, ".claude/agents/mine.md"), "mine\n");
    await recordCapabilityEntry(ctx, "alpha");
    await recordCapabilityEntry(ctx, "beta");

    await uninstallPlugins(ctx, [ALPHA, BETA], { only: ["alpha"] });

    expect(existsSync(join(ctx.cwd, ".claude/skills"))).toBe(false);
    expect(existsSync(join(ctx.cwd, ".claude/agents/mine.md"))).toBe(true);
    expect(workspaceEntries(ctx).map((entry) => entry.target)).toEqual([
      ".claude",
      ".claude/agents",
    ]);
  });

  it("leaves no directory and no entry once the last capability goes", async () => {
    const ctx = await createTestContext();
    await createRecordedDirectory(ctx, ".claude/skills");
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(existsSync(join(ctx.cwd, ".claude"))).toBe(false);
    expect(existsSync(join(ctx.cwd, ".agemon"))).toBe(false);
  });

  it("drops the entry of a directory that is already gone", async () => {
    const ctx = await createTestContext();
    await createRecordedDirectory(ctx, ".claude/agents");
    await rm(join(ctx.cwd, ".claude"), { recursive: true });
    await recordCapabilityEntry(ctx, "alpha");
    await recordCapabilityEntry(ctx, "beta");

    await uninstallPlugins(ctx, [ALPHA, BETA], { only: ["alpha"] });

    expect(workspaceEntries(ctx)).toEqual([]);
  });

  it("ignores a recorded directory outside the allowlist and a claim", async () => {
    const ctx = await createTestContext();
    await mkdir(join(ctx.cwd, "src"));
    await ctx.manifest.recordAction({
      plugin: WORKSPACE_PLUGIN_ID,
      type: "created-directory",
      target: "src",
      resourceId: "created-directory:src",
      preExisting: false,
    });
    await mkdir(join(ctx.cwd, ".claude/agents"), { recursive: true });
    await appendLedgerClaims(ctx, [
      {
        plugin: WORKSPACE_PLUGIN_ID,
        type: "created-directory",
        target: ".claude/agents",
        resourceId: "created-directory:.claude/agents",
        preExisting: false,
      },
    ]);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(existsSync(join(ctx.cwd, "src"))).toBe(true);
    expect(existsSync(join(ctx.cwd, ".claude/agents"))).toBe(true);
  });

  it("never removes a directory through a symlinked parent", async () => {
    const ctx = await createTestContext();
    const outside = await mkdtemp(join(tmpdir(), "agemon-footprint-outside-"));
    createdTempDirectories.push(outside);
    await mkdir(join(outside, "skills"));
    await symlink(outside, join(ctx.cwd, ".claude"));
    await recordCreatedDirectories(ctx, [".claude/skills"]);
    await recordCapabilityEntry(ctx, "alpha");

    await uninstallPlugins(ctx, [ALPHA], {});

    expect(existsSync(join(outside, "skills"))).toBe(true);
  });
});
