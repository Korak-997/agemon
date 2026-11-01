import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplyRollbackError, applyPlan } from "../../../src/core/apply.js";
import { readJournals, writeJournal } from "../../../src/core/apply-journal.js";
import type { Context } from "../../../src/core/context.js";
import { fakePinnedSkillManifest } from "../../../src/core/fake-pinned-skills.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { fingerprintJson } from "../../../src/core/fingerprint.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import { type Plan, writePlan } from "../../../src/core/plan-store.js";
import { recoverInterruptedApply } from "../../../src/core/recover.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
import {
  fingerprintInstalledSkill,
  fingerprintSkillSource,
} from "../../../src/plugins/skills/skill-tree.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { seedInstalledSkills } from "../installed-skills.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const shippedHistory = vi.hoisted(() => ({
  history: {} as Record<string, string[]>,
  pinned: {} as Record<string, Record<string, string>>,
}));

vi.mock("../../../src/plugins/skills/bundle-fingerprints.js", () => ({
  BUNDLE_FINGERPRINTS: shippedHistory,
}));

const COMMIT_SKILL = "agemon-commit";
const COMMIT_COPY = `.claude/skills/${COMMIT_SKILL}`;
const OLD_COMMIT_SKILL_MANIFEST = "---\nname: agemon-commit\n---\n\nold\n";
const runningAsRoot = process.getuid?.() === 0;
const createdTempDirectories: string[] = [];

beforeEach(() => {
  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  resetFakeSubprocessState();
  shippedHistory.history = {};
  shippedHistory.pinned = {};
});

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
  resetFakeSubprocessState();
});

async function createTestContext(): Promise<Context> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-skill-revisions-"));
  createdTempDirectories.push(cwd);
  return {
    cwd,
    gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
    platform: LINUX_TEST_PLATFORM,
    binaries: [],
    dryRun: false,
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
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
    run: runSubprocess,
    manifest: await StateManifest.load(cwd),
    serviceManager: {} as ServiceManager,
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

async function recordInstalled(ctx: Context, skillName: string): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "skills",
    type: "installed-skill",
    target: skillName,
    preExisting: false,
  });
}

async function installCurrentCommitSkill(ctx: Context): Promise<void> {
  await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
  await cp(
    resolveVendoredSkillPath("commit", COMMIT_SKILL),
    join(ctx.cwd, COMMIT_COPY),
    { recursive: true },
  );
  await recordInstalled(ctx, COMMIT_SKILL);
}

async function writeCopy(
  ctx: Context,
  relativeDirectory: string,
  manifest: string,
): Promise<string> {
  const directory = join(ctx.cwd, relativeDirectory);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), manifest);
  return directory;
}

async function writeLockOfEarlierInstall(ctx: Context): Promise<void> {
  await writeFile(
    join(ctx.cwd, "skills-lock.json"),
    `${JSON.stringify({ version: 1, skills: { [COMMIT_SKILL]: {} } }, null, 2)}\n`,
  );
}

async function shipFingerprintOf(directory: string): Promise<void> {
  shippedHistory.history[COMMIT_SKILL] = [
    await fingerprintInstalledSkill(directory),
  ];
}

async function commitGroupRow(ctx: Context) {
  const rows = (await skillsPlugin.describeState?.(ctx)) ?? [];
  return rows.find((row) => row.resourceId === "skill-group:commit");
}

async function keptNotes(ctx: Context): Promise<string[]> {
  const lines: string[] = [];
  await skillsPlugin.verify({
    ...ctx,
    ui: { ...ctx.ui, info: (line: string) => lines.push(line) },
  });
  return lines;
}

function keptNote(skillName: string, reason: string): string {
  return `skills: agemon keeps ${skillName} (${reason}); to get agemon's version, delete .claude/skills/${skillName} and run agemon`;
}

describe("bundled skill revisions in status and verify", () => {
  it("a copy identical to the current bundle is current", async () => {
    const ctx = await createTestContext();
    await installCurrentCommitSkill(ctx);

    expect(await commitGroupRow(ctx)).toMatchObject({
      state: "present-managed",
      detail: "1 skill(s)",
    });
    expect((await skillsPlugin.verify(ctx)).attention).toBeUndefined();
  });

  it("a copy identical to a released version is reported as an update", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );

    expect(await commitGroupRow(ctx)).toMatchObject({
      state: "present-managed",
      detail: "1 skill(s); update available for 1 skill(s)",
    });
    expect((await skillsPlugin.verify(ctx)).attention).toBe(
      `a newer bundled version of ${COMMIT_SKILL} is available; run agemon`,
    );
  });

  it("a historical copy named only by an unconfirmed entry is still an update", async () => {
    const ctx = await createTestContext();
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: "installed-skill",
        target: COMMIT_SKILL,
        preExisting: false,
      },
    ]);
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );

    expect((await skillsPlugin.verify(ctx)).attention).toContain(COMMIT_SKILL);
  });

  it("an edited real .claude/skills copy is kept whatever .agents/skills holds", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await shipFingerprintOf(
      await writeCopy(
        ctx,
        `.agents/skills/${COMMIT_SKILL}`,
        OLD_COMMIT_SKILL_MANIFEST,
      ),
    );
    await writeCopy(ctx, COMMIT_COPY, `${OLD_COMMIT_SKILL_MANIFEST}my edit\n`);

    expect(await commitGroupRow(ctx)).toMatchObject({
      state: "present-modified",
      detail: `1 skill(s); agemon keeps ${COMMIT_SKILL}`,
    });
    expect(await keptNotes(ctx)).toEqual([
      keptNote(COMMIT_SKILL, "differs from every version agemon shipped"),
    ]);
    expect((await skillsPlugin.verify(ctx)).attention).toBeUndefined();
  });

  it("a .claude/skills symlink to a historical .agents/skills copy is an update", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await shipFingerprintOf(
      await writeCopy(
        ctx,
        `.agents/skills/${COMMIT_SKILL}`,
        OLD_COMMIT_SKILL_MANIFEST,
      ),
    );
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(
      `../../.agents/skills/${COMMIT_SKILL}`,
      join(ctx.cwd, COMMIT_COPY),
    );

    expect((await commitGroupRow(ctx))?.detail).toContain(
      "update available for 1 skill(s)",
    );
  });

  it("a .claude/skills symlink anywhere else is kept, even with a historical .agents/skills copy", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    const elsewhere = await writeCopy(
      ctx,
      "elsewhere/agemon-commit",
      OLD_COMMIT_SKILL_MANIFEST,
    );
    await writeCopy(
      ctx,
      `.agents/skills/${COMMIT_SKILL}`,
      OLD_COMMIT_SKILL_MANIFEST,
    );
    await shipFingerprintOf(elsewhere);
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(elsewhere, join(ctx.cwd, COMMIT_COPY));

    expect(await keptNotes(ctx)).toEqual([
      keptNote(
        COMMIT_SKILL,
        `it is a symlink that does not point to .agents/skills/${COMMIT_SKILL}`,
      ),
    ]);
  });

  it("a .claude/skills symlink through a symlinked .agents is kept", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    const realAgents = await writeCopy(
      ctx,
      `real-agents/skills/${COMMIT_SKILL}`,
      OLD_COMMIT_SKILL_MANIFEST,
    );
    await shipFingerprintOf(realAgents);
    await symlink(join(ctx.cwd, "real-agents"), join(ctx.cwd, ".agents"));
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(
      `../../.agents/skills/${COMMIT_SKILL}`,
      join(ctx.cwd, COMMIT_COPY),
    );

    expect(await commitGroupRow(ctx)).toMatchObject({
      state: "present-modified",
    });
  });

  it("a skill listed by the CLI but missing from .claude/skills is kept with its reason", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await seedInstalledSkills(ctx.cwd, [COMMIT_SKILL], "agents");

    expect(await keptNotes(ctx)).toEqual([
      keptNote(COMMIT_SKILL, `not at ${COMMIT_COPY}`),
    ]);
  });

  it("a skill whose latest confirmed record is preexisting-skill is never reported, even when historical", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await ctx.manifest.recordAction({
      plugin: "skills",
      type: "preexisting-skill",
      target: COMMIT_SKILL,
      preExisting: true,
    });
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );

    expect((await skillsPlugin.verify(ctx)).attention).toBeUndefined();
  });

  it("a skill recorded only by an unconfirmed preexisting-skill entry is never reported", async () => {
    const ctx = await createTestContext();
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: "preexisting-skill",
        target: COMMIT_SKILL,
        preExisting: true,
      },
    ]);
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );

    expect((await skillsPlugin.verify(ctx)).attention).toBeUndefined();
  });

  it("an unconfirmed preexisting-skill claim after a confirmed install does not stop the update", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: "preexisting-skill",
        target: COMMIT_SKILL,
        preExisting: true,
      },
    ]);
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );

    expect((await skillsPlugin.verify(ctx)).attention).toContain(COMMIT_SKILL);
  });

  it("two contexts for the same repository do not share classifications", async () => {
    const first = await createTestContext();
    await outdatedCommitSkill(first);
    expect((await skillsPlugin.verify(first)).attention).toContain(
      COMMIT_SKILL,
    );
    await rm(join(first.cwd, COMMIT_COPY), { recursive: true });
    await cp(vendoredCommitSource(), join(first.cwd, COMMIT_COPY), {
      recursive: true,
    });
    const second: Context = {
      ...first,
      manifest: await StateManifest.load(first.cwd),
    };

    expect((await skillsPlugin.verify(second)).attention).toBeUndefined();
  });

  it("4.7.2 Essentials content that differs from the pin is kept; the pinned stand-in is current", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, "web-design-guidelines");
    await recordInstalled(ctx, "writing-guidelines");
    await writeCopy(
      ctx,
      ".claude/skills/web-design-guidelines",
      "---\nname: web-design-guidelines\n---\n\nupstream in 2025\n",
    );
    await writeCopy(
      ctx,
      ".claude/skills/writing-guidelines",
      fakePinnedSkillManifest("writing-guidelines"),
    );

    const rows = (await skillsPlugin.describeState?.(ctx)) ?? [];

    expect(
      rows.find((row) => row.resourceId === "skill-group:essentials"),
    ).toMatchObject({
      state: "present-modified",
      detail: "2 skill(s); agemon keeps web-design-guidelines",
    });
    expect(await keptNotes(ctx)).toEqual([
      keptNote(
        "web-design-guidelines",
        "differs from every version agemon shipped",
      ),
    ]);
  });

  it.each([
    [
      "a symlink inside the skill",
      async (copy: string) => symlink("/etc/hostname", join(copy, "link")),
      "link is a symlink or not a regular file",
    ],
    [
      "a FIFO",
      async (copy: string) => {
        execFileSync("mkfifo", [join(copy, "pipe")]);
      },
      "pipe is a symlink or not a regular file",
    ],
    [
      "more than 200 entries",
      async (copy: string) => {
        for (let index = 0; index < 201; index += 1) {
          await writeFile(join(copy, `f${index}`), "x");
        }
      },
      "it has more than 200 entries",
    ],
    [
      "depth over 8",
      async (copy: string) => {
        await mkdir(join(copy, "a/b/c/d/e/f/g/h/i"), { recursive: true });
      },
      "it is nested deeper than 8 levels",
    ],
    [
      "more than 8 MiB",
      async (copy: string) => {
        await writeFile(join(copy, "big"), Buffer.alloc(8 * 1024 * 1024 + 1));
      },
      "it is larger than 8 MiB",
    ],
    [
      "an installed __pycache__ directory",
      async (copy: string) => {
        await mkdir(join(copy, "__pycache__"));
      },
      "differs from every version agemon shipped",
    ],
  ])(
    "%s keeps the copy without failing status or verify",
    async (_label, prepare, reason) => {
      const ctx = await createTestContext();
      await installCurrentCommitSkill(ctx);
      await prepare(join(ctx.cwd, COMMIT_COPY));

      expect((await commitGroupRow(ctx))?.detail).toBe(
        `1 skill(s); agemon keeps ${COMMIT_SKILL}`,
      );
      expect(await keptNotes(ctx)).toEqual([keptNote(COMMIT_SKILL, reason)]);
      await expect(skillsPlugin.verify(ctx)).resolves.toMatchObject({
        ok: true,
      });
    },
  );

  it.skipIf(runningAsRoot)(
    "an unreadable subdirectory keeps the copy with its error code",
    async () => {
      const ctx = await createTestContext();
      await installCurrentCommitSkill(ctx);
      const locked = join(ctx.cwd, COMMIT_COPY, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "x"), "x");
      execFileSync("chmod", ["000", locked]);
      try {
        expect(await keptNotes(ctx)).toEqual([
          keptNote(COMMIT_SKILL, "agemon could not read it (EACCES)"),
        ]);
      } finally {
        execFileSync("chmod", ["700", locked]);
      }
    },
  );

  it("a symlinked .claude/skills keeps every copy without failing", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    await writeCopy(ctx, `real/${COMMIT_SKILL}`, OLD_COMMIT_SKILL_MANIFEST);
    await mkdir(join(ctx.cwd, ".claude"));
    await symlink(join(ctx.cwd, "real"), join(ctx.cwd, ".claude/skills"));

    expect(await keptNotes(ctx)).toEqual([
      keptNote(
        COMMIT_SKILL,
        "it is a symlink or sits under a symlinked directory",
      ),
    ]);
    await expect(skillsPlugin.verify(ctx)).resolves.toMatchObject({ ok: true });
  });

  it(".DS_Store files in an installed copy are ignored; a .DS_Store directory is not", async () => {
    const ctx = await createTestContext();
    await installCurrentCommitSkill(ctx);
    await writeFile(join(ctx.cwd, COMMIT_COPY, ".DS_Store"), "finder");

    expect((await commitGroupRow(ctx))?.state).toBe("present-managed");

    const otherCtx = await createTestContext();
    await installCurrentCommitSkill(otherCtx);
    await mkdir(join(otherCtx.cwd, COMMIT_COPY, ".DS_Store"));

    expect((await commitGroupRow(otherCtx))?.state).toBe("present-modified");
  });
});

async function planSkills(ctx: Context): Promise<ProposedOperation[]> {
  return (await skillsPlugin.plan?.(ctx)) ?? [];
}

function commitOperation(
  operations: ProposedOperation[],
): ProposedOperation | undefined {
  return operations.find(
    (operation) => operation.resourceId === "skill-group:commit",
  );
}

async function outdatedCommitSkill(ctx: Context): Promise<string> {
  await recordInstalled(ctx, COMMIT_SKILL);
  const copy = await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST);
  await shipFingerprintOf(copy);
  return fingerprintInstalledSkill(copy);
}

function vendoredCommitSource(): string {
  return resolveVendoredSkillPath("commit", COMMIT_SKILL);
}

function asPlan(operations: ProposedOperation[]): Plan {
  return {
    id: "0123456789abcdef",
    agemonVersion: "9.9.9",
    desiredStateHash: "hash",
    inputs: { capabilityIds: [], skillGroups: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    operations,
  };
}

function breakerPlugin(): AgemonPlugin {
  return {
    id: "breaker",
    async detect() {
      return { present: false, preExisting: false };
    },
    async install() {
      throw new Error("breaker exploded");
    },
    async verify() {
      return { ok: true };
    },
    async uninstall() {},
  };
}

function breakerOperationLike(template: ProposedOperation): ProposedOperation {
  return {
    ...template,
    id: "breaker:res:install-package",
    capabilityId: "breaker",
    resourceId: "res",
    expectedFingerprint: null,
    updates: undefined,
  };
}

function failingAddOf(skillName: string): Context["run"] {
  return async (command, args, options) =>
    args.includes("add") && args.includes(skillName)
      ? { code: 1, stdout: "", stderr: "add failed on purpose" }
      : runSubprocess(command, args, options);
}

describe("bundled skill updates in plan and apply", () => {
  it("a vendored skill identical to a released copy is planned as an update in its group's install-package operation", async () => {
    const ctx = await createTestContext();
    const installedFingerprint = await outdatedCommitSkill(ctx);
    const currentFingerprint = await fingerprintSkillSource(
      vendoredCommitSource(),
    );

    const operation = commitOperation(await planSkills(ctx));

    expect(operation).toMatchObject({
      action: "install-package",
      riskClass: "executes",
      updates: [
        { name: COMMIT_SKILL, installedFingerprint, currentFingerprint },
      ],
      expectedFingerprint: fingerprintJson([
        [COMMIT_SKILL, installedFingerprint, currentFingerprint],
      ]),
    });
    expect(operation?.preview.text).toContain(
      `${COMMIT_SKILL} — bundled with agemon — update (bundled content changed)`,
    );
  });

  it("plans no update for a current, edited or preexisting skill", async () => {
    const current = await createTestContext();
    await installCurrentCommitSkill(current);
    const edited = await createTestContext();
    await recordInstalled(edited, COMMIT_SKILL);
    await shipFingerprintOf(
      await writeCopy(
        edited,
        `.agents/skills/${COMMIT_SKILL}`,
        OLD_COMMIT_SKILL_MANIFEST,
      ),
    );
    await writeCopy(edited, COMMIT_COPY, `${OLD_COMMIT_SKILL_MANIFEST}edit\n`);
    const preexisting = await createTestContext();
    await outdatedCommitSkill(preexisting);
    await preexisting.manifest.recordAction({
      plugin: "skills",
      type: "preexisting-skill",
      target: COMMIT_SKILL,
      preExisting: true,
    });

    expect(commitOperation(await planSkills(current))).toBeUndefined();
    expect(commitOperation(await planSkills(edited))).toBeUndefined();
    expect(commitOperation(await planSkills(preexisting))).toBeUndefined();
  });

  it("an update replaces .claude/skills/<name> and writes no ledger entry; a claim stays a claim", async () => {
    const ctx = await createTestContext();
    await appendLedgerClaims(ctx, [
      {
        plugin: "skills",
        type: "installed-skill",
        target: COMMIT_SKILL,
        preExisting: false,
      },
    ]);
    await shipFingerprintOf(
      await writeCopy(ctx, COMMIT_COPY, OLD_COMMIT_SKILL_MANIFEST),
    );
    await writeLockOfEarlierInstall(ctx);
    const ledgerBefore = ctx.manifest.getActions();
    const operation = commitOperation(await planSkills(ctx));

    await skillsPlugin.apply?.(ctx, operation === undefined ? [] : [operation]);

    expect(await fingerprintInstalledSkill(join(ctx.cwd, COMMIT_COPY))).toBe(
      await fingerprintSkillSource(vendoredCommitSource()),
    );
    expect(ctx.manifest.getActions()).toEqual(ledgerBefore);
    expect(ctx.manifest.isConfirmed(ledgerBefore[0])).toBe(false);
  });

  it("apply refuses when a skill changed between plan and apply", async () => {
    const ctx = await createTestContext();
    await outdatedCommitSkill(ctx);
    const operation = commitOperation(await planSkills(ctx));
    await writeFile(join(ctx.cwd, COMMIT_COPY, "SKILL.md"), "changed\n");

    await expect(
      skillsPlugin.apply?.(ctx, operation === undefined ? [] : [operation]),
    ).rejects.toThrow(
      "The skill group 'commit' changed since it was planned. Re-run 'agemon plan' and review it again.",
    );
    expect(await readFile(join(ctx.cwd, COMMIT_COPY, "SKILL.md"), "utf8")).toBe(
      "changed\n",
    );
  });

  it("a failed add that never touched the copy keeps it, and the next plan offers the update again", async () => {
    const ctx = await createTestContext();
    const installedFingerprint = await outdatedCommitSkill(ctx);
    const operation = commitOperation(await planSkills(ctx));
    const failingCtx = { ...ctx, run: failingAddOf(COMMIT_SKILL) };

    await expect(
      skillsPlugin.apply?.(
        failingCtx,
        operation === undefined ? [] : [operation],
      ),
    ).rejects.toThrow("add failed on purpose");

    expect(await fingerprintInstalledSkill(join(ctx.cwd, COMMIT_COPY))).toBe(
      installedFingerprint,
    );
    expect(commitOperation(await planSkills({ ...ctx }))?.updates).toEqual(
      operation?.updates,
    );
  });

  it("a failed add that half-wrote the copy removes it, and the next plan repairs it", async () => {
    const ctx = await createTestContext();
    await outdatedCommitSkill(ctx);
    const operation = commitOperation(await planSkills(ctx));
    const halfWritingCtx: Context = {
      ...ctx,
      run: async (command, args, options) => {
        if (args.includes("add") && args.includes(COMMIT_SKILL)) {
          await writeFile(join(ctx.cwd, COMMIT_COPY, "partial"), "x");
          return { code: 1, stdout: "", stderr: "add failed on purpose" };
        }
        return runSubprocess(command, args, options);
      },
    };

    await expect(
      skillsPlugin.apply?.(
        halfWritingCtx,
        operation === undefined ? [] : [operation],
      ),
    ).rejects.toThrow("add failed on purpose");

    expect(existsSync(join(ctx.cwd, COMMIT_COPY))).toBe(false);
    const repair = commitOperation(await planSkills({ ...ctx }));
    expect(repair).toMatchObject({ action: "install-package" });
    expect(repair?.updates).toBeUndefined();
  });

  it("each update is re-checked inside the lock right before its add", async () => {
    const ctx = await createTestContext();
    const designSkills = [
      "agemon-design",
      "agemon-design-minimal",
      "agemon-design-editorial",
      "agemon-design-dashboard",
    ];
    for (const name of designSkills) {
      await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
      await cp(
        resolveVendoredSkillPath("design", name),
        join(ctx.cwd, ".claude/skills", name),
        { recursive: true },
      );
      await recordInstalled(ctx, name);
    }
    for (const name of designSkills.slice(0, 2)) {
      const copy = await writeCopy(
        ctx,
        `.claude/skills/${name}`,
        `---\nname: ${name}\n---\n\nold\n`,
      );
      shippedHistory.history[name] = [await fingerprintInstalledSkill(copy)];
    }
    const operation = (await planSkills(ctx)).find(
      (candidate) => candidate.resourceId === "skill-group:design",
    );
    expect(operation?.updates?.map((update) => update.name)).toEqual(
      designSkills.slice(0, 2),
    );
    const racingCtx: Context = {
      ...ctx,
      run: async (command, args, options) => {
        const result = await runSubprocess(command, args, options);
        if (args.includes("add") && args.includes("agemon-design")) {
          await writeFile(
            join(ctx.cwd, ".claude/skills/agemon-design-minimal/SKILL.md"),
            "edited meanwhile\n",
          );
        }
        return result;
      },
    };

    await expect(
      skillsPlugin.apply?.(
        racingCtx,
        operation === undefined ? [] : [operation],
      ),
    ).rejects.toThrow(
      "The skill group 'design' changed since it was planned. Re-run 'agemon plan' and review it again.",
    );
    expect(
      await readFile(
        join(ctx.cwd, ".claude/skills/agemon-design-minimal/SKILL.md"),
        "utf8",
      ),
    ).toBe("edited meanwhile\n");
  });

  it("updating a symlinked copy in a repository opened through a symlink replaces only the link", async () => {
    const realCtx = await createTestContext();
    const linkedRoot = `${realCtx.cwd}-link`;
    await symlink(realCtx.cwd, linkedRoot);
    createdTempDirectories.push(linkedRoot);
    const ctx: Context = { ...realCtx, cwd: linkedRoot };
    await recordInstalled(ctx, COMMIT_SKILL);
    const canonical = await writeCopy(
      ctx,
      `.agents/skills/${COMMIT_SKILL}`,
      OLD_COMMIT_SKILL_MANIFEST,
    );
    await shipFingerprintOf(canonical);
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(
      `../../.agents/skills/${COMMIT_SKILL}`,
      join(ctx.cwd, COMMIT_COPY),
    );
    const operation = commitOperation(await planSkills(ctx));
    expect(operation?.updates?.map((update) => update.name)).toEqual([
      COMMIT_SKILL,
    ]);

    await skillsPlugin.apply?.(ctx, operation === undefined ? [] : [operation]);

    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(
      OLD_COMMIT_SKILL_MANIFEST,
    );
    expect(await fingerprintInstalledSkill(join(ctx.cwd, COMMIT_COPY))).toBe(
      await fingerprintSkillSource(vendoredCommitSource()),
    );
  });

  it("a failed add over a symlinked copy leaves the link and .agents/skills untouched", async () => {
    const ctx = await createTestContext();
    await recordInstalled(ctx, COMMIT_SKILL);
    const canonical = await writeCopy(
      ctx,
      `.agents/skills/${COMMIT_SKILL}`,
      OLD_COMMIT_SKILL_MANIFEST,
    );
    await shipFingerprintOf(canonical);
    await mkdir(join(ctx.cwd, ".claude/skills"), { recursive: true });
    await symlink(
      `../../.agents/skills/${COMMIT_SKILL}`,
      join(ctx.cwd, COMMIT_COPY),
    );
    const operation = commitOperation(await planSkills(ctx));

    await expect(
      skillsPlugin.apply?.(
        { ...ctx, run: failingAddOf(COMMIT_SKILL) },
        operation === undefined ? [] : [operation],
      ),
    ).rejects.toThrow("add failed on purpose");

    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(
      OLD_COMMIT_SKILL_MANIFEST,
    );
    expect(existsSync(join(ctx.cwd, COMMIT_COPY))).toBe(true);
  });

  it("a content mismatch after add removes the copy and fails the apply", async () => {
    const ctx = await createTestContext();
    await outdatedCommitSkill(ctx);
    const operation = commitOperation(await planSkills(ctx));
    const tamperingCtx: Context = {
      ...ctx,
      run: async (command, args, options) => {
        const result = await runSubprocess(command, args, options);
        if (args.includes("add")) {
          await writeFile(join(ctx.cwd, COMMIT_COPY, "extra"), "x");
        }
        return result;
      },
    };

    await expect(
      skillsPlugin.apply?.(
        tamperingCtx,
        operation === undefined ? [] : [operation],
      ),
    ).rejects.toThrow(
      `The skills CLI installed ${COMMIT_SKILL} with different content than agemon bundles`,
    );
    expect(existsSync(join(ctx.cwd, COMMIT_COPY))).toBe(false);
  });

  it('rollback after an update keeps the new content and reports "Kept updated skill"', async () => {
    const ctx = await createTestContext();
    const failLines: string[] = [];
    const infoLines: string[] = [];
    ctx.ui = {
      ...ctx.ui,
      fail: (line: string) => failLines.push(line),
      info: (line: string) => infoLines.push(line),
    };
    await writeFile(join(ctx.cwd, ".gitignore"), "/.agemon/\n");
    await outdatedCommitSkill(ctx);
    const update = commitOperation(await planSkills(ctx));
    if (update === undefined) {
      throw new Error("expected an update operation");
    }
    const operations = [update, breakerOperationLike(update)];

    const failure = await applyPlan(ctx, [skillsPlugin, breakerPlugin()], {
      plan: asPlan(operations),
      approved: operations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplyRollbackError);
    expect((failure as ApplyRollbackError).rollback.kept).toEqual([
      `Kept updated skill ${COMMIT_SKILL} (agemon's newer version)`,
    ]);
    expect(failLines).toContainEqual(
      expect.stringContaining("except the changes kept below"),
    );
    expect(infoLines).toContain(
      `Kept updated skill ${COMMIT_SKILL} (agemon's newer version)`,
    );
    expect(await fingerprintInstalledSkill(join(ctx.cwd, COMMIT_COPY))).toBe(
      await fingerprintSkillSource(vendoredCommitSource()),
    );
    expect(commitOperation(await planSkills({ ...ctx }))).toBeUndefined();
  });

  it("a failure before the update lands reports nothing as kept", async () => {
    const ctx = await createTestContext();
    await writeFile(join(ctx.cwd, ".gitignore"), "/.agemon/\n");
    const installedFingerprint = await outdatedCommitSkill(ctx);
    const update = commitOperation(await planSkills(ctx));
    if (update === undefined) {
      throw new Error("expected an update operation");
    }
    const operations = [breakerOperationLike(update), update];

    const failure = await applyPlan(ctx, [skillsPlugin, breakerPlugin()], {
      plan: asPlan(operations),
      approved: operations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    }).catch((error: unknown) => error);

    expect((failure as ApplyRollbackError).rollback.kept).toEqual([]);
    expect(await fingerprintInstalledSkill(join(ctx.cwd, COMMIT_COPY))).toBe(
      installedFingerprint,
    );
  });

  it("recover after a kill that followed an update-only skills run prints the kept update", async () => {
    const ctx = await createTestContext();
    const logLines: string[] = [];
    ctx.log = { ...console, log: (line: string) => logLines.push(line) };
    await outdatedCommitSkill(ctx);
    await writeLockOfEarlierInstall(ctx);
    const update = commitOperation(await planSkills(ctx));
    if (update === undefined) {
      throw new Error("expected an update operation");
    }
    const plan = asPlan([update]);
    await writePlan(ctx.cwd, plan);
    await writeJournal(ctx.cwd, {
      planId: plan.id,
      startedAt: "2026-11-01T00:00:00.000Z",
      capabilityOrder: ["skills"],
      ledgerBefore: ctx.manifest.getActions(),
      snapshots: [],
    });
    await skillsPlugin.apply?.(ctx, [update]);

    await recoverInterruptedApply(ctx, [skillsPlugin], { dryRun: false });

    const output = logLines.join("\n");
    expect(output).toContain(
      `Nothing to undo for plan ${plan.id}; agemon keeps what it already finished:\n  - Kept updated skill ${COMMIT_SKILL} (agemon's newer version)`,
    );
    expect(output).not.toContain("the files and the ledger already match");
    expect(await readJournals(ctx.cwd)).toEqual([]);
  });

  it("recover with other changes to undo rolls them back and prints the kept update", async () => {
    const ctx = await createTestContext();
    const infoLines: string[] = [];
    const logLines: string[] = [];
    ctx.ui = { ...ctx.ui, info: (line: string) => infoLines.push(line) };
    ctx.log = { ...console, log: (line: string) => logLines.push(line) };
    await outdatedCommitSkill(ctx);
    const update = commitOperation(await planSkills(ctx));
    if (update === undefined) {
      throw new Error("expected an update operation");
    }
    const plan = asPlan([update]);
    await writePlan(ctx.cwd, plan);
    await writeJournal(ctx.cwd, {
      planId: plan.id,
      startedAt: "2026-11-01T00:00:00.000Z",
      capabilityOrder: ["skills"],
      ledgerBefore: ctx.manifest.getActions(),
      snapshots: [],
    });
    ctx.manifest.setRecordingPlanId(plan.id);
    await skillsPlugin.apply?.(ctx, [update]);
    await recordInstalled(ctx, "agemon-security");
    ctx.manifest.setRecordingPlanId(null);
    ctx.confirm = async () => true;

    await recoverInterruptedApply(ctx, [skillsPlugin], { dryRun: false });

    expect(logLines.join("\n")).toContain(
      `keep updated skill ${COMMIT_SKILL} (agemon's newer version)`,
    );
    expect(infoLines).toContain(
      `Kept updated skill ${COMMIT_SKILL} (agemon's newer version)`,
    );
  });

  it("post-apply verify after an update reports no update available", async () => {
    const ctx = await createTestContext();
    await outdatedCommitSkill(ctx);
    expect((await skillsPlugin.verify(ctx)).attention).toContain(COMMIT_SKILL);
    const operation = commitOperation(await planSkills(ctx));

    await skillsPlugin.apply?.(ctx, operation === undefined ? [] : [operation]);

    expect((await skillsPlugin.verify(ctx)).attention).toBeUndefined();
  });
});
