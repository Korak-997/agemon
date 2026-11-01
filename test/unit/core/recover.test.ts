import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../../src/core/apply.js";
import {
  type JournalSnapshot,
  readJournals,
  resolveJournalDirectory,
  writeJournal,
} from "../../../src/core/apply-journal.js";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { ensureGitignoreEntry } from "../../../src/core/gitignore.js";
import { buildPlan } from "../../../src/core/orchestrator.js";
import {
  RECOVER_LIMIT_NOTE,
  recoverInterruptedApply,
} from "../../../src/core/recover.js";
import { ensureRepoDirectory } from "../../../src/core/repo-paths.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  recordCreatedDirectories,
  recordGitignoreLine,
} from "../../../src/core/workspace-footprint.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const PLAN_ID = "0123456789abcdef";
const runningAsRoot = process.getuid?.() === 0;
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
      return { active: false, failed: false };
    },
    async isSandboxEnforced() {
      return false;
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

interface RecoverHarness {
  ctx: Context;
  output: string[];
}

async function createHarness(
  overrides: Partial<Context> = {},
): Promise<RecoverHarness> {
  const repo = await mkdtemp(join(tmpdir(), "agemon-recover-test-"));
  createdTempDirectories.push(repo);
  const output: string[] = [];
  const record = (message: string) => {
    output.push(message);
  };
  return {
    output,
    ctx: {
      cwd: repo,
      gitConfigGuard: CLEAN_GIT_CONFIG_GUARD,
      platform: LINUX_TEST_PLATFORM,
      binaries: [],
      dryRun: false,
      yes: true,
      interactive: false,
      log: { log: record, error: record },
      ui: { start() {}, succeed: record, fail: record, info: record },
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      manifest: await StateManifest.load(repo),
      serviceManager: createNoOpServiceManager(),
      verifiedBinaryInstaller: {
        install: async () => {},
        inspect: async () => ({ kind: "absent" }),
      },
      confirm: async () => true,
      consent: async () => ({
        approved: [],
        skipped: [],
        workspaceIsolationApproved: null,
        conflictResolutions: [],
      }),
      ...overrides,
    },
  };
}

function revertingPlugin(
  id: string,
  revert: AgemonPlugin["revert"] = async () => {},
): AgemonPlugin & { revertedTargets: string[][] } {
  const revertedTargets: string[][] = [];
  return {
    id,
    revertedTargets,
    async detect() {
      return { present: false, preExisting: false };
    },
    async install() {},
    async verify() {
      return { ok: true };
    },
    async revert(ctx, entries) {
      revertedTargets.push(entries.map((entry) => entry.target));
      await revert?.(ctx, entries);
    },
    async uninstall() {},
  };
}

function snapshot(
  targetPath: string,
  previousContents: string | null,
  stagedContents: string,
): JournalSnapshot {
  return {
    targetPath,
    previousContents,
    stagedFingerprint: fingerprintContent(stagedContents),
  };
}

async function simulateKilledApply(
  ctx: Context,
  options: {
    snapshots?: JournalSnapshot[];
    capabilityOrder?: string[];
  } = {},
): Promise<string> {
  const { path } = await writeJournal(ctx.cwd, {
    planId: PLAN_ID,
    startedAt: "2026-10-24T00:00:00.000Z",
    capabilityOrder: options.capabilityOrder ?? ["master-prompt", "cli-tool"],
    ledgerBefore: ctx.manifest.getActions(),
    snapshots: options.snapshots ?? [],
  });
  return path;
}

async function recordInstalledTool(
  ctx: Context,
  target: string,
  planId: string = PLAN_ID,
): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "cli-tool",
    type: "installed-global-package",
    target,
    preExisting: false,
    planId,
  });
}

describe("agemon recover", () => {
  it("restores the files, reverts new entries, restores the ledger and deletes the journal", async () => {
    const { ctx, output } = await createHarness();
    await ctx.manifest.recordAction({
      plugin: "cli-tool",
      type: "installed-global-package",
      target: "from-earlier",
      preExisting: false,
    });
    await simulateKilledApply(ctx, {
      snapshots: [
        snapshot("AGENTS.md", "original\n", "agemon rules\n"),
        snapshot("CLAUDE.md", null, "pointer\n"),
      ],
    });
    await writeFile(join(ctx.cwd, "AGENTS.md"), "agemon rules\n", "utf8");
    await writeFile(join(ctx.cwd, "CLAUDE.md"), "pointer\n", "utf8");
    await recordInstalledTool(ctx, "agnix");
    const cliTool = revertingPlugin("cli-tool");

    await recoverInterruptedApply(
      ctx,
      [revertingPlugin("master-prompt"), cliTool],
      {
        dryRun: false,
      },
    );

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "original\n",
    );
    await expect(
      readFile(join(ctx.cwd, "CLAUDE.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(cliTool.revertedTargets).toEqual([["agnix"]]);
    expect(ctx.manifest.getActions().map((entry) => entry.target)).toEqual([
      "from-earlier",
    ]);
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
    expect(output.join("\n")).toContain("  - restore AGENTS.md");
    expect(output.join("\n")).toContain("  - remove CLAUDE.md");
    expect(output.join("\n")).toContain("  - revert cli-tool: agnix");
    expect(output.join("\n")).toContain(
      "  - ledger: reset to its 1 pre-apply entries",
    );
    expect(output.join("\n")).toContain(
      "Interrupted writes may leave '<file>.tmp-<pid>-<id>' files next to the targets; delete them if present.",
    );
    expect(output.at(-1)).toBe(
      `Recovered the interrupted apply of plan ${PLAN_ID}.`,
    );
  });

  it("removes the empty .claude/skills a killed apply created, and keeps the gitignore-line entry", async () => {
    const { ctx, output } = await createHarness();
    await simulateKilledApply(ctx, { capabilityOrder: ["cli-tool"] });
    ctx.manifest.setRecordingPlanId(PLAN_ID);
    await recordCreatedDirectories(
      ctx,
      await ensureRepoDirectory(ctx.cwd, ".claude/skills"),
    );
    await recordGitignoreLine(
      ctx,
      "/skills-lock.json",
      await ensureGitignoreEntry(ctx.cwd, "/skills-lock.json"),
    );
    await recordInstalledTool(ctx, "agnix");

    await recoverInterruptedApply(ctx, [revertingPlugin("cli-tool")], {
      dryRun: false,
    });

    expect(existsSync(join(ctx.cwd, ".claude"))).toBe(false);
    expect(ctx.manifest.getActions().map((entry) => entry.resourceId)).toEqual([
      "gitignore-line:/skills-lock.json",
    ]);
    expect(output.join("\n")).toContain(
      "  - remove empty directories agemon created: .claude/skills, .claude",
    );
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("never sweeps a directory named only by an unconfirmed entry of the run", async () => {
    const { ctx } = await createHarness();
    await simulateKilledApply(ctx, { capabilityOrder: ["cli-tool"] });
    await mkdir(join(ctx.cwd, ".claude"));
    await appendLedgerClaims(ctx, [
      {
        plugin: "workspace",
        type: "created-directory",
        target: ".claude",
        resourceId: "created-directory:.claude",
        preExisting: false,
        planId: PLAN_ID,
      },
    ]);
    await recordInstalledTool(ctx, "agnix");

    await recoverInterruptedApply(ctx, [revertingPlugin("cli-tool")], {
      dryRun: false,
    });

    expect(existsSync(join(ctx.cwd, ".claude"))).toBe(true);
  });

  it("previews no ledger change for an unconfirmed directory entry the rollback keeps", async () => {
    const { ctx, output } = await createHarness();
    await simulateKilledApply(ctx, { capabilityOrder: ["cli-tool"] });
    await appendLedgerClaims(ctx, [
      {
        plugin: "workspace",
        type: "created-directory",
        target: ".claude",
        resourceId: "created-directory:.claude",
        preExisting: false,
        planId: PLAN_ID,
      },
    ]);

    await recoverInterruptedApply(ctx, [revertingPlugin("cli-tool")], {
      dryRun: true,
    });

    expect(output.join("\n")).toContain("Nothing to recover:");
  });

  it("says there is nothing to recover when no journal exists", async () => {
    const { ctx, output } = await createHarness();

    await recoverInterruptedApply(ctx, [], { dryRun: false });

    expect(output).toEqual(["Nothing to recover."]);
  });

  it("deletes a journal whose changes are already undone", async () => {
    const { ctx, output } = await createHarness();
    await writeFile(join(ctx.cwd, "AGENTS.md"), "original\n", "utf8");
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });

    await recoverInterruptedApply(
      ctx,
      [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
      {
        dryRun: false,
      },
    );

    expect(output).toEqual([
      `Nothing to recover: the files and the ledger already match their state before plan ${PLAN_ID}.\n${RECOVER_LIMIT_NOTE}`,
    ]);
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("refuses when more than one journal exists", async () => {
    const { ctx } = await createHarness();
    await simulateKilledApply(ctx);
    await writeJournal(ctx.cwd, {
      planId: "fedcba9876543210",
      startedAt: "2026-10-24T00:00:00.000Z",
      capabilityOrder: [],
      ledgerBefore: [],
      snapshots: [],
    });

    await expect(
      recoverInterruptedApply(ctx, [], { dryRun: false }),
    ).rejects.toThrow(/Found 2 interrupted-apply journals/);
  });

  it("restores nothing without consent when not interactive", async () => {
    const { ctx } = await createHarness({ yes: false, interactive: false });
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });
    await writeFile(join(ctx.cwd, "AGENTS.md"), "agemon rules\n", "utf8");

    await expect(
      recoverInterruptedApply(
        ctx,
        [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
        {
          dryRun: false,
        },
      ),
    ).rejects.toThrow("Nothing restored: re-run interactively or with --yes.");

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "agemon rules\n",
    );
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it("only previews under --dry-run", async () => {
    const { ctx, output } = await createHarness();
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });
    await writeFile(join(ctx.cwd, "AGENTS.md"), "agemon rules\n", "utf8");

    await recoverInterruptedApply(
      ctx,
      [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
      {
        dryRun: true,
      },
    );

    expect(output.join("\n")).toContain("  - restore AGENTS.md");
    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "agemon rules\n",
    );
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });

  it("leaves a file edited after the interruption as is, and saves the pre-apply contents beside it", async () => {
    const { ctx, output } = await createHarness();
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });
    await writeFile(join(ctx.cwd, "AGENTS.md"), "edited by the user\n", "utf8");

    await expect(
      recoverInterruptedApply(
        ctx,
        [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
        {
          dryRun: false,
        },
      ),
    ).rejects.toThrow(/manual cleanup/);

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "edited by the user\n",
    );
    await expect(
      readFile(join(ctx.cwd, "AGENTS.md.agemon-original"), "utf8"),
    ).resolves.toBe("original\n");
    expect(output).toContain(
      "manual cleanup needed: AGENTS.md: changed since the apply started — kept as is; its pre-apply contents are saved as AGENTS.md.agemon-original",
    );
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("saves the original bytes beside a target that became a symlink, then deletes the journal", async () => {
    const { ctx } = await createHarness();
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });
    await writeFile(join(ctx.cwd, "elsewhere.md"), "elsewhere\n", "utf8");
    await symlink("elsewhere.md", join(ctx.cwd, "AGENTS.md"));

    await expect(
      recoverInterruptedApply(
        ctx,
        [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
        {
          dryRun: false,
        },
      ),
    ).rejects.toThrow(/manual cleanup/);

    await expect(
      readFile(join(ctx.cwd, "AGENTS.md.agemon-original"), "utf8"),
    ).resolves.toBe("original\n");
    await expect(readFile(join(ctx.cwd, "elsewhere.md"), "utf8")).resolves.toBe(
      "elsewhere\n",
    );
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it.skipIf(runningAsRoot)(
    "saves the pre-apply contents beside a target it cannot restore, and still deletes the journal",
    async () => {
      const { ctx, output } = await createHarness();
      await simulateKilledApply(ctx, {
        snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
      });
      await writeFile(join(ctx.cwd, "AGENTS.md"), "agemon rules\n", {
        mode: 0o400,
      });

      await expect(
        recoverInterruptedApply(
          ctx,
          [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
          {
            dryRun: false,
          },
        ),
      ).rejects.toThrow(/manual cleanup/);

      await expect(
        readFile(join(ctx.cwd, "AGENTS.md.agemon-original"), "utf8"),
      ).resolves.toBe("original\n");
      expect(
        output.some((line) =>
          /^manual cleanup needed: AGENTS\.md: could not restore it \(.*read-only.*\); its pre-apply contents are saved as AGENTS\.md\.agemon-original$/.test(
            line,
          ),
        ),
      ).toBe(true);
      await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
    },
  );

  it.skipIf(runningAsRoot)(
    "keeps the journal and names it when the pre-apply contents cannot be saved either",
    async () => {
      const { ctx } = await createHarness();
      await mkdir(join(ctx.cwd, "docs"));
      const journalPath = await simulateKilledApply(ctx, {
        snapshots: [snapshot("docs/rules.md", "original\n", "agemon rules\n")],
      });
      await writeFile(join(ctx.cwd, "docs/rules.md"), "agemon rules\n", "utf8");
      await chmod(join(ctx.cwd, "docs"), 0o500);

      try {
        await expect(
          recoverInterruptedApply(
            ctx,
            [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
            {
              dryRun: false,
            },
          ),
        ).rejects.toThrow(
          `Kept the journal ${journalPath}, because it holds the only copy of 1 file(s) agemon could not restore or save.`,
        );
      } finally {
        await chmod(join(ctx.cwd, "docs"), 0o700);
      }
      await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
    },
  );

  it("does not revert entries recorded under another plan id", async () => {
    const { ctx } = await createHarness();
    await simulateKilledApply(ctx);
    await recordInstalledTool(ctx, "forged-tool", "ffffffffffffffff");
    await recordInstalledTool(ctx, "agnix");
    const cliTool = revertingPlugin("cli-tool");

    await recoverInterruptedApply(
      ctx,
      [revertingPlugin("master-prompt"), cliTool],
      {
        dryRun: false,
      },
    );

    expect(cliTool.revertedTargets).toEqual([["agnix"]]);
  });

  it("retries a revert that failed during the in-process rollback, and only then drops its entries", async () => {
    const { ctx } = await createHarness();
    let revertAttempts = 0;
    const flaky: AgemonPlugin = {
      ...revertingPlugin("cli-tool", async () => {
        revertAttempts += 1;
        if (revertAttempts === 1) {
          throw new Error("npm registry unreachable");
        }
      }),
      async install(installCtx) {
        await installCtx.manifest.recordAction({
          plugin: "cli-tool",
          type: "installed-global-package",
          target: "agnix",
          preExisting: false,
        });
        throw new Error("verify failed");
      },
    };
    const op: ProposedOperation = {
      id: "cli-tool:agnix:install",
      capabilityId: "cli-tool",
      resourceId: "agnix",
      targetPath: "",
      action: "install-package",
      riskClass: "executes",
      requiresConsent: true,
      expectedFingerprint: null,
      preview: { kind: "note", text: "" },
    };

    await expect(
      applyPlan(ctx, [flaky], {
        plan: {
          id: PLAN_ID,
          agemonVersion: "9.9.9",
          desiredStateHash: "hash",
          inputs: { capabilityIds: [], skillGroups: null },
          createdAt: "2026-10-24T00:00:00.000Z",
          operations: [op],
        },
        approved: [op],
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow(/verify failed/);
    expect(ctx.manifest.getActions().map((entry) => entry.target)).toEqual([
      "agnix",
    ]);
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);

    await recoverInterruptedApply(ctx, [flaky], { dryRun: false });

    expect(revertAttempts).toBe(2);
    expect(ctx.manifest.getActions()).toEqual([]);
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });

  it("treats a journal naming an unknown capability as invalid", async () => {
    const { ctx } = await createHarness();
    const journalPath = await simulateKilledApply(ctx, {
      capabilityOrder: ["mystery"],
    });

    await expect(
      recoverInterruptedApply(ctx, [], { dryRun: false }),
    ).rejects.toThrow(
      `The interrupted-apply journal ${journalPath} is invalid: it names unknown capabilities: mystery.`,
    );
  });

  it("refuses a journal that belongs to another repository", async () => {
    const { ctx } = await createHarness();
    const directory = await resolveJournalDirectory(ctx.cwd);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${PLAN_ID}.json`),
      JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        repoRoot: `${await realpath(ctx.cwd)}-other`,
        startedAt: "2026-10-24T00:00:00.000Z",
        capabilityOrder: [],
        ledgerBefore: [],
        snapshots: [],
      }),
      "utf8",
    );

    await expect(
      recoverInterruptedApply(ctx, [], { dryRun: false }),
    ).rejects.toThrow(/belongs to another repository/);
  });
});

describe("agemon recover with the real master-prompt plugin", () => {
  it("never rewrites a rule file the user edited after the interruption, and keeps its ledger entry", async () => {
    const { ctx, output } = await createHarness();
    await writeFile(join(ctx.cwd, "AGENTS.md"), "# mine\n", "utf8");
    const plan = await buildPlan(ctx, [masterPromptPlugin], {
      agemonVersion: "9.9.9",
    });
    const fileOperations = plan.operations.filter(
      (operation) => operation.action !== "conflict",
    );
    await applyPlan(ctx, [masterPromptPlugin], {
      plan,
      approved: fileOperations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    });
    const writtenAgents = await readFile(join(ctx.cwd, "AGENTS.md"), "utf8");
    await writeJournal(ctx.cwd, {
      planId: plan.id,
      startedAt: "2026-10-24T00:00:00.000Z",
      capabilityOrder: ["master-prompt"],
      ledgerBefore: [],
      snapshots: [snapshot("AGENTS.md", "# mine\n", writtenAgents)],
    });
    const editedAgents = `${writtenAgents}user line\n`;
    await writeFile(join(ctx.cwd, "AGENTS.md"), editedAgents, "utf8");

    await expect(
      recoverInterruptedApply(ctx, [masterPromptPlugin], { dryRun: false }),
    ).rejects.toThrow(/manual cleanup/);

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      editedAgents,
    );
    await expect(
      readFile(join(ctx.cwd, "AGENTS.md.agemon-original"), "utf8"),
    ).resolves.toBe("# mine\n");
    expect(
      ctx.manifest
        .getActions()
        .filter((entry) => entry.plugin === "master-prompt")
        .map((entry) => entry.target),
    ).toEqual(["AGENTS.md"]);
    expect(output.join("\n")).toContain(
      "keep AGENTS.md and agemon's ledger entry for it",
    );
    await expect(readJournals(ctx.cwd)).resolves.toEqual([]);
  });
});

describe("agemon recover consent", () => {
  it("exits non-zero and keeps the journal when the user declines", async () => {
    const { ctx } = await createHarness({
      yes: false,
      interactive: true,
      confirm: async () => false,
    });
    await simulateKilledApply(ctx, {
      snapshots: [snapshot("AGENTS.md", "original\n", "agemon rules\n")],
    });
    await writeFile(join(ctx.cwd, "AGENTS.md"), "agemon rules\n", "utf8");

    await expect(
      recoverInterruptedApply(
        ctx,
        [revertingPlugin("master-prompt"), revertingPlugin("cli-tool")],
        { dryRun: false },
      ),
    ).rejects.toThrow(/Nothing restored\. agemon stays blocked/);

    await expect(readFile(join(ctx.cwd, "AGENTS.md"), "utf8")).resolves.toBe(
      "agemon rules\n",
    );
    await expect(readJournals(ctx.cwd)).resolves.toHaveLength(1);
  });
});
