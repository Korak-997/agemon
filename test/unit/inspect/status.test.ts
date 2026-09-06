import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import {
  buildStatusReport,
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
): Promise<void> {
  await context.manifest.recordAction({
    plugin: "master-prompt",
    type: "managed-rule-file",
    target,
    preExisting: false,
    resourceId: `rule-file:${target}`,
    ownershipMode: "delimited-block",
    fingerprintAfter: fingerprintContent(contents),
  });
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

  it("surfaces daemon health only when the daemon is ledger-recorded", async () => {
    const context = await createStatusContext();
    const unhealthyDaemon: AgemonPlugin = {
      id: "daemon",
      async detect() {
        return { present: false, preExisting: false };
      },
      async install() {},
      async verify() {
        return { ok: false, detail: "unit is not active" };
      },
      async uninstall() {},
    };

    expect(
      (await buildStatusReport(context, [unhealthyDaemon])).daemon,
    ).toBeNull();

    await context.manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: "agemon-crg-daemon.service",
      preExisting: false,
    });

    const report = await buildStatusReport(context, [unhealthyDaemon]);
    expect(report.daemon).toEqual({ ok: false, detail: "unit is not active" });
    expect(report.healthy).toBe(false);
  });
});
