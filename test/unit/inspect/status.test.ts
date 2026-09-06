import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  buildStatusReport,
  checkManagedResources,
  verifyManagedState,
} from "../../../src/inspect/status.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
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
