import { execFileSync } from "node:child_process";
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
import { writeJournal } from "../../../src/core/apply-journal.js";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { discoverRepository } from "../../../src/inspect/discover.js";
import {
  buildStatusReport,
  checkManagedResources,
  verifyManagedState,
} from "../../../src/inspect/status.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { masterPromptPlugin } from "../../../src/plugins/master-prompt/index.js";
import type { AgemonPlugin } from "../../../src/plugins/types.js";
import { renderStatusReport } from "../../../src/ui/status-view.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

async function createStatusContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-status-test-"));
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
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
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

async function recordManagedRuleFile(
  context: Context,
  target: string,
  contents: string,
  desiredRevision?: string,
): Promise<void> {
  await context.manifest.recordAction({
    plugin: "master-prompt",
    type: "managed-rule-file",
    target,
    preExisting: false,
    resourceId: `rule-file:${target}`,
    ownershipMode: "delimited-block",
    fingerprintAfter: fingerprintContent(contents),
    desiredRevision,
  });
}

function stubRevisionPlugin(revision: string | null): AgemonPlugin {
  return {
    id: "master-prompt",
    desiredRevision: () => revision,
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

describe("status", () => {
  it("reports managed-current, then managed-drifted, then missing", async () => {
    const context = await createStatusContext();
    const managed = "# rules\n\nagemon owns this.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), managed, "utf8");
    await recordManagedRuleFile(context, "AGENTS.md", managed);

    const currentReport = await buildStatusReport(context, []);
    expect(currentReport.managedResources[0].health).toBe("managed-current");
    expect(currentReport.healthy).toBe(true);
    expect(currentReport.agentsSummary).toEqual({
      total: 3,
      configured: 0,
      installed: 0,
    });
    expect(await verifyManagedState(context)).toEqual([]);

    await writeFile(
      join(context.cwd, "AGENTS.md"),
      `${managed}\nhand edit\n`,
      "utf8",
    );
    const driftedReport = await buildStatusReport(context, []);
    expect(driftedReport.managedResources[0].health).toBe("managed-drifted");
    expect(driftedReport.healthy).toBe(false);
    expect(await verifyManagedState(context)).toHaveLength(1);

    await rm(join(context.cwd, "AGENTS.md"));
    const missingReport = await buildStatusReport(context, []);
    expect(missingReport.managedResources[0].health).toBe("missing");
  });

  it("flags a fingerprint-matching file as drifted when agemon's template moved on", async () => {
    const context = await createStatusContext();
    const managed = "# rules\n\nagemon owns this.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), managed, "utf8");
    await recordManagedRuleFile(
      context,
      "AGENTS.md",
      managed,
      "template-rev-1",
    );

    const currentRows = await checkManagedResources(context, [
      stubRevisionPlugin("template-rev-1"),
    ]);
    expect(currentRows[0].health).toBe("managed-current");

    const driftedRows = await checkManagedResources(context, [
      stubRevisionPlugin("template-rev-2"),
    ]);
    expect(driftedRows[0].health).toBe("managed-drifted");
    expect(driftedRows[0].detail).toBe(
      "agemon template updated — re-run to refresh",
    );

    const report = await buildStatusReport(context, [
      stubRevisionPlugin("template-rev-2"),
    ]);
    expect(report.healthy).toBe(false);
    expect(
      await verifyManagedState(context, [stubRevisionPlugin("rev-x")]),
    ).toEqual([
      "AGENTS.md is behind agemon's current template; re-run to refresh",
    ]);

    expect(await readFile(join(context.cwd, "AGENTS.md"), "utf8")).toBe(
      managed,
    );
  });

  it("attaches a capability health verdict only when the capability is ledger-recorded", async () => {
    const context = await createStatusContext();
    const unhealthyDaemon: AgemonPlugin = {
      id: "daemon",
      async detect() {
        return { present: false, preExisting: false };
      },
      async describeState() {
        return [
          {
            capabilityId: "daemon",
            resourceId: "service-unit:agemon-crg-daemon.service",
            label: "agemon-crg-daemon.service",
            state: "absent" as const,
            detail: null,
          },
        ];
      },
      async install() {},
      async verify() {
        return { ok: false, detail: "unit is not active" };
      },
      async uninstall() {},
    };

    const beforeRecord = await buildStatusReport(context, [unhealthyDaemon]);
    expect(beforeRecord.capabilities).toHaveLength(1);
    expect(beforeRecord.capabilities[0].health).toBeNull();
    expect(beforeRecord.healthy).toBe(true);

    await context.manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: "agemon-crg-daemon.service",
      preExisting: false,
    });

    const report = await buildStatusReport(context, [unhealthyDaemon]);
    expect(report.capabilities[0].health).toEqual({
      ok: false,
      detail: "unit is not active",
      attention: null,
    });
    expect(report.healthy).toBe(false);
  });

  it("reports a working capability that needs attention as unhealthy, with its warning", async () => {
    const context = await createStatusContext();
    const flaggedTool: AgemonPlugin = {
      id: "cli-tool",
      async detect() {
        return { present: true, preExisting: false };
      },
      async describeState() {
        return [
          {
            capabilityId: "cli-tool",
            resourceId: "package:agnix",
            label: "agnix",
            state: "present-managed" as const,
            detail: "installed via npm (agnix 0.41.0)",
          },
        ];
      },
      async install() {},
      async verify() {
        return {
          ok: true,
          detail: "1 CLI tool bundle entries present",
          attention: "agnix is not the pinned agnix 0.58.0 build",
        };
      },
      async uninstall() {},
    };
    await context.manifest.recordAction({
      plugin: "cli-tool",
      type: "installed-cli-tool",
      target: "agnix",
      preExisting: false,
    });

    const report = await buildStatusReport(context, [flaggedTool]);

    expect(report.healthy).toBe(false);
    expect(renderStatusReport(report)).toContain(
      "agnix is not the pinned agnix 0.58.0 build",
    );
    expect(renderStatusReport(report)).toContain("needs attention");
  });

  it("does not report agemon's own pointer files as duplication", async () => {
    const context = await createStatusContext();
    const canonical = "# AI Agent Rules\n\nagemon owns this rule set.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), canonical, "utf8");
    await recordManagedRuleFile(context, "AGENTS.md", canonical);

    const pointer = (tool: string, name: string) =>
      [
        "# AI Agent Rules",
        "",
        "The canonical rules for this repo live in AGENTS.md — read that file in full before",
        `making any changes here. This file exists only because ${tool} looks for \`${name}\`.`,
        "",
      ].join("\n");
    await writeFile(
      join(context.cwd, "CLAUDE.md"),
      pointer("Claude Code", "CLAUDE.md"),
      "utf8",
    );
    await writeFile(
      join(context.cwd, "GEMINI.md"),
      pointer("Gemini CLI", "GEMINI.md"),
      "utf8",
    );

    const report = await buildStatusReport(context, []);
    expect(report.duplication).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(await verifyManagedState(context)).toEqual([]);
  });

  it("still flags a rule-bearing file that duplicates AGENTS.md", async () => {
    const context = await createStatusContext();
    const canonical = [
      "# AI Agent Rules",
      "",
      "Always discover existing tools before writing new code.",
      "Keep every change surgical and scoped to the request at hand.",
      "Preserve user-authored content outside agemon-managed files.",
      "Record out-of-scope findings in improvements.md instead of fixing them.",
    ].join("\n");
    await writeFile(join(context.cwd, "AGENTS.md"), canonical, "utf8");
    await writeFile(
      join(context.cwd, "CLAUDE.md"),
      `${canonical}\n\nExtra Claude-only note.\n`,
      "utf8",
    );

    const report = await buildStatusReport(context, []);
    expect(report.duplication).toHaveLength(1);
    expect(report.duplication[0].leftRole).toBe("canonical");
    expect(report.duplication[0].bothRuleBearing).toBe(true);
    expect(report.healthy).toBe(false);
    expect(await verifyManagedState(context)).toEqual([
      "duplicate guidance across managed files: AGENTS.md ~ CLAUDE.md",
    ]);
  });
});

const HOSTILE_READ_TIMEOUT_MS = 2000;

describe("status and discovery against hostile repo contents", () => {
  async function plantHostileFiles(context: Context): Promise<void> {
    const outside = await mkdtemp(join(tmpdir(), "agemon-status-outside-"));
    createdTempDirectories.push(outside);
    await writeFile(join(outside, "copilot-instructions.md"), "x\n", "utf8");
    await symlink("/dev/zero", join(context.cwd, "CLAUDE.md"));
    execFileSync("mkfifo", [join(context.cwd, "GEMINI.md")]);
    await symlink(outside, join(context.cwd, ".github"));
    await writeFile(
      join(context.cwd, ".mcp.json"),
      "x".repeat(9 * 1024 * 1024),
      "utf8",
    );
  }

  it(
    "discovers symlinks, FIFOs and oversized files as present but unread",
    async () => {
      const context = await createStatusContext();
      await plantHostileFiles(context);

      const discovery = await discoverRepository(context);

      const ruleFile = (path: string) =>
        discovery.ruleFiles.find((file) => file.path === path);
      expect(ruleFile("CLAUDE.md")).toMatchObject({
        exists: true,
        contents: null,
      });
      expect(ruleFile("GEMINI.md")).toMatchObject({
        exists: true,
        contents: null,
      });
      expect(
        discovery.structuredConfigs.find((file) => file.path === ".mcp.json"),
      ).toMatchObject({
        exists: true,
        parsed: null,
        parseError: expect.stringMatching(/^not read: .*larger than 8 MiB/),
      });
      expect(discovery.copilotInstructions).toEqual([
        {
          kind: "copilot-instruction",
          path: ".github/copilot-instructions.md",
          exists: true,
        },
      ]);
    },
    HOSTILE_READ_TIMEOUT_MS,
  );

  it(
    "finishes a status report with a symlinked managed AGENTS.md",
    async () => {
      const context = await createStatusContext();
      await plantHostileFiles(context);
      await mkdir(join(context.cwd, "real"));
      await writeFile(join(context.cwd, "real/AGENTS.md"), "# rules\n", "utf8");
      await symlink(
        join(context.cwd, "real/AGENTS.md"),
        join(context.cwd, "AGENTS.md"),
      );
      await recordManagedRuleFile(context, "AGENTS.md", "# rules\n");

      const report = await buildStatusReport(context, [masterPromptPlugin]);

      expect(report.managedResources[0]).toMatchObject({
        target: "AGENTS.md",
        health: "managed-drifted",
      });
      expect(report.healthy).toBe(false);
    },
    HOSTILE_READ_TIMEOUT_MS,
  );

  it("reports a ledger target outside the repo as a problem instead of throwing", async () => {
    const context = await createStatusContext();
    await recordManagedRuleFile(context, "../outside.md", "anything\n");

    await expect(verifyManagedState(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^ignoring ledger entry for \.\.\/outside\.md: master-prompt does not manage that file$/,
        ),
      ]),
    );
  });
});

describe("discoverRepository git tracking check", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  it("never runs a core.fsmonitor hook that the repository configures", async () => {
    const context = await createStatusContext();
    git(context.cwd, ["init", "-q"]);
    const marker = join(context.cwd, "fsmonitor-ran");
    const hook = join(context.cwd, "hook.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(context.cwd, ["config", "core.fsmonitor", hook]);

    const discovery = await discoverRepository(context);

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(discovery.isolation.trackingCheckError).toBeNull();
  });

  it("never runs a git planted in the repository's node_modules/.bin when npm launched agemon", async () => {
    const context = await createStatusContext();
    git(context.cwd, ["init", "-q"]);
    const plantedBin = join(context.cwd, "node_modules", ".bin");
    const marker = join(context.cwd, "planted-git-ran");
    await mkdir(plantedBin, { recursive: true });
    await writeFile(join(plantedBin, "git"), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("PATH", `${plantedBin}:${process.env.PATH}`);

    const discovery = await discoverRepository(context);

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(discovery.isolation.trackingCheckError).toBeNull();
  });

  it("reports a failed tracking check instead of treating .agemon/ as untracked", async () => {
    const context = await createStatusContext();
    await mkdir(join(context.cwd, ".git"));

    const discovery = await discoverRepository(context);

    expect(discovery.isolation.trackedAgemonPaths).toEqual([]);
    expect(discovery.isolation.trackingCheckError).toMatch(
      /^could not check whether \.agemon\/ is tracked by git: /,
    );
    const report = await buildStatusReport(context, []);
    expect(report.healthy).toBe(true);
    expect(renderStatusReport(report)).not.toContain(
      ".agemon/ is not tracked by git",
    );
    expect(discovery.isolation.status).toBe("no-gitignore-file");
  });

  it("with /.agemon/ listed, a broken .git also reports that git could not confirm the ignore", async () => {
    const context = await createStatusContext();
    await mkdir(join(context.cwd, ".git"));
    await writeFile(join(context.cwd, ".gitignore"), "/.agemon/\n", "utf8");

    const discovery = await discoverRepository(context);

    expect(discovery.isolation.status).toBe("not-ignored");
    expect(discovery.isolation.trackingCheckError).toMatch(
      /^could not ask git whether \.agemon\/ is ignored: .*; could not check whether \.agemon\/ is tracked by git: /,
    );
    expect((await buildStatusReport(context, [])).healthy).toBe(true);
  });

  it("does not warn outside a git repository", async () => {
    const context = await createStatusContext();

    const discovery = await discoverRepository(context);

    expect(discovery.isolation.trackingCheckError).toBeNull();
  });
});

describe("status with agemon state", () => {
  it("flags an open interrupted-apply journal and points to 'agemon recover'", async () => {
    const context = await createStatusContext();
    await writeJournal(context.cwd, {
      planId: "0123456789abcdef",
      startedAt: "2026-10-24T00:00:00.000Z",
      capabilityOrder: ["master-prompt"],
      ledgerBefore: [],
      snapshots: [],
    });

    const report = await buildStatusReport(context, []);

    expect(report.interruptedApply).toEqual({
      planId: "0123456789abcdef",
      startedAt: "2026-10-24T00:00:00.000Z",
    });
    expect(report.healthy).toBe(false);
    expect(report.hasAgemonState).toBe(true);
    const rendered = renderStatusReport(report).replace(/[\s│]+/g, " ");
    expect(rendered).toContain(
      "An earlier apply (plan 0123456789abcdef, started 2026-10-24T00:00:00.000Z) was interrupted — run 'agemon recover'.",
    );
  });

  it("reports no agemon state for a repo agemon never touched, even with duplication", async () => {
    const context = await createStatusContext();
    const rules =
      "## Rules\n\n- Always write tests before code.\n- Never commit secrets.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), rules, "utf8");
    await writeFile(join(context.cwd, "CLAUDE.md"), rules, "utf8");

    const report = await buildStatusReport(context, []);

    expect(report.healthy).toBe(false);
    expect(report.hasAgemonState).toBe(false);
  });

  it("counts ledger entries this machine did not write and says what agemon won't act on", async () => {
    const context = await createStatusContext();
    await recordManagedRuleFile(context, "AGENTS.md", "rules\n");
    await appendLedgerClaims(context, [
      {
        plugin: "skills",
        type: "installed-skill",
        target: "geo-audit",
        preExisting: false,
      },
      {
        plugin: "crg",
        type: "installed-binary",
        target: "code-review-graph (pipx)",
        preExisting: false,
      },
    ]);

    const report = await buildStatusReport(context, []);

    expect(report.unconfirmedLedgerEntries).toBe(2);
    expect(renderStatusReport(report).replace(/[\s│]+/g, " ")).toContain(
      "2 ledger entries were not written by agemon on this machine; agemon won't remove, replace or repair the skills, subagents, shared tools, daemon units or code graph they name.",
    );
  });

  it("reports agemon state once the ledger has entries", async () => {
    const context = await createStatusContext();
    await recordManagedRuleFile(context, "AGENTS.md", "rules\n");

    const report = await buildStatusReport(context, []);

    expect(report.hasAgemonState).toBe(true);
  });
});
