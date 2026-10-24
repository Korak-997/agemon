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
import { afterEach, describe, expect, it } from "vitest";
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
      return { unitPath: "", lingerEnabledByAgemon: false };
    },
    async unregisterAutostart() {
      return;
    },
  };
}

async function createStatusContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-status-test-"));
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
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
    });
    expect(report.healthy).toBe(false);
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

  it("reports an unreadable forged ledger target as an escaped problem instead of aborting", async () => {
    const context = await createStatusContext();
    await recordManagedRuleFile(
      context,
      `\u001b]0;pwned\u0007${"x".repeat(300)}`,
      "anything\n",
    );

    const problems = await verifyManagedState(context);

    const report = problems.join("\n");
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\u0007");
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ignoring ledger entry for \?\]0;pwned\?x+/),
      ]),
    );
  });

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
