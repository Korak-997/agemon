import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { inspectRepository, runInspect } from "../../../src/inspect/index.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { crgPlugin } from "../../../src/plugins/crg/index.js";
import { skillsPlugin } from "../../../src/plugins/skills/index.js";
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

function createNoOpUi(): Context["ui"] {
  return { start() {}, succeed() {}, fail() {}, info() {} };
}

async function createInspectContext(): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-inspect-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
    binaries: [
      { name: "python3", present: true },
      { name: "code-review-graph", present: false },
    ],
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
    ui: createNoOpUi(),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
  };
}

function stateForPath(
  report: Awaited<ReturnType<typeof inspectRepository>>,
  path: string,
): string | undefined {
  return report.resources.find((resource) => resource.path === path)?.state;
}

describe("inspectRepository", () => {
  it("classifies every resource as absent in an empty repo and writes nothing", async () => {
    const context = await createInspectContext();

    const report = await inspectRepository(context);

    expect(
      report.resources
        .filter((resource) => resource.kind === "rule-file")
        .every((resource) => resource.state === "absent"),
    ).toBe(true);
    expect(
      report.structuredConfig.every((config) => config.status === "absent"),
    ).toBe(true);
    expect(report.isolation.status).toBe("no-gitignore-file");
    expect(report.duplication.overlaps).toEqual([]);

    await expect(
      readFile(join(context.cwd, ".agemon/reports/state.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("adopts a pointer file and leaves hand-written AGENTS.md unmanaged", async () => {
    const context = await createInspectContext();
    await writeFile(
      join(context.cwd, "AGENTS.md"),
      "# House rules\n\nRun the linter before committing.\n",
      "utf8",
    );
    await writeFile(
      join(context.cwd, "CLAUDE.md"),
      "# AI Agent Rules\n\nThe canonical rules live in AGENTS.md — read it first.\n",
      "utf8",
    );

    const report = await inspectRepository(context);

    expect(stateForPath(report, "AGENTS.md")).toBe("unmanaged");
    expect(stateForPath(report, "CLAUDE.md")).toBe("equivalent");
  });

  it("reports isolation status from .gitignore", async () => {
    const ignoredContext = await createInspectContext();
    await writeFile(
      join(ignoredContext.cwd, ".gitignore"),
      "node_modules\n/.agemon/\n",
      "utf8",
    );
    expect((await inspectRepository(ignoredContext)).isolation.status).toBe(
      "ignored",
    );

    const unignoredContext = await createInspectContext();
    await writeFile(
      join(unignoredContext.cwd, ".gitignore"),
      "node_modules\n",
      "utf8",
    );
    expect((await inspectRepository(unignoredContext)).isolation.status).toBe(
      "not-ignored",
    );
  });

  it("redacts credential-shaped values in structured config", async () => {
    const context = await createInspectContext();
    await mkdir(join(context.cwd, ".claude"), { recursive: true });
    await writeFile(
      join(context.cwd, ".claude/settings.json"),
      JSON.stringify({
        model: "claude-sonnet-5",
        mcpServers: { api: { url: "https://x", token: "sk-live-shh-secret" } },
      }),
      "utf8",
    );

    const report = await inspectRepository(context);
    const claudeSettings = report.structuredConfig.find(
      (config) => config.path === ".claude/settings.json",
    );

    expect(claudeSettings?.status).toBe("present");
    expect(claudeSettings?.redactedPaths).toContain("mcpServers.api.token");
    expect(JSON.stringify(report)).not.toContain("sk-live-shh-secret");
  });

  it("marks malformed structured config invalid without throwing", async () => {
    const context = await createInspectContext();
    await writeFile(join(context.cwd, ".mcp.json"), "{ not valid json", "utf8");

    const report = await inspectRepository(context);

    expect(stateForPath(report, ".mcp.json")).toBe("invalid");
    expect(
      report.structuredConfig.find((config) => config.path === ".mcp.json")
        ?.status,
    ).toBe("invalid");
  });

  it("discovers scoped Copilot instructions as unmanaged", async () => {
    const context = await createInspectContext();
    await mkdir(join(context.cwd, ".github/instructions"), { recursive: true });
    await writeFile(
      join(context.cwd, ".github/instructions/api.instructions.md"),
      "---\napplyTo: src/api/**\n---\nUse zod for validation.\n",
      "utf8",
    );

    const report = await inspectRepository(context);

    expect(
      stateForPath(report, ".github/instructions/api.instructions.md"),
    ).toBe("unmanaged");
  });

  it("produces a byte-stable report for unchanged input", async () => {
    const context = await createInspectContext();
    await writeFile(
      join(context.cwd, "AGENTS.md"),
      "# Rules\n\nBe surgical.\n",
      "utf8",
    );

    const first = await inspectRepository(context);
    const second = await inspectRepository(context);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("classifies a ledger-owned rule file as managed-current, then managed-drifted", async () => {
    const context = await createInspectContext();
    const managedContents = "# Managed rules\n\nAgemon owns this file.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), managedContents, "utf8");
    await context.manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: false,
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "created",
      fingerprintAfter: fingerprintContent(managedContents),
    });

    expect(stateForPath(await inspectRepository(context), "AGENTS.md")).toBe(
      "managed-current",
    );

    await writeFile(
      join(context.cwd, "AGENTS.md"),
      `${managedContents}\nHand edit.\n`,
      "utf8",
    );
    expect(stateForPath(await inspectRepository(context), "AGENTS.md")).toBe(
      "managed-drifted",
    );
  });

  it("classifies a fingerprint-matching file as drifted when agemon's template moved on", async () => {
    const context = await createInspectContext();
    const managedContents = "# Managed rules\n\nAgemon owns this file.\n";
    await writeFile(join(context.cwd, "AGENTS.md"), managedContents, "utf8");
    await context.manifest.recordAction({
      plugin: "master-prompt",
      type: "managed-rule-file",
      target: "AGENTS.md",
      preExisting: false,
      resourceId: "rule-file:AGENTS.md",
      ownershipMode: "delimited-block",
      fingerprintAfter: fingerprintContent(managedContents),
      desiredRevision: "template-rev-1",
    });

    const revisionPlugin = (revision: string): AgemonPlugin => ({
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
    });

    const currentResource = (
      await inspectRepository(context, [revisionPlugin("template-rev-1")])
    ).resources.find((resource) => resource.path === "AGENTS.md");
    expect(currentResource?.state).toBe("managed-current");

    const driftedResource = (
      await inspectRepository(context, [revisionPlugin("template-rev-2")])
    ).resources.find((resource) => resource.path === "AGENTS.md");
    expect(driftedResource?.state).toBe("managed-drifted");
    expect(driftedResource?.detail).toBe(
      "agemon template updated — re-run to refresh",
    );
  });
});

function stubCapabilityPlugin(
  id: string,
  rows: Awaited<ReturnType<NonNullable<AgemonPlugin["describeState"]>>>,
): AgemonPlugin {
  return {
    id,
    async detect() {
      return { present: true, preExisting: false };
    },
    async describeState() {
      return rows;
    },
    async install() {},
    async verify() {
      return { ok: true };
    },
    async uninstall() {},
  };
}

describe("inspectRepository capabilities", () => {
  it("aggregates describeState rows in a deterministic order", async () => {
    const context = await createInspectContext();

    const report = await inspectRepository(context, [
      stubCapabilityPlugin("skills", [
        {
          capabilityId: "skills",
          resourceId: "skill-groups:none",
          label: "skill groups",
          state: "absent",
          detail: null,
        },
      ]),
      stubCapabilityPlugin("crg", [
        {
          capabilityId: "crg",
          resourceId: "package:code-review-graph",
          label: "code-review-graph",
          state: "present-adopted",
          detail: "pre-existing install",
        },
      ]),
    ]);

    expect(report.capabilities.map((row) => row.capabilityId)).toEqual([
      "crg",
      "skills",
    ]);
    expect(report.capabilities[0].state).toBe("present-adopted");
    expect(report.capabilities[1].state).toBe("absent");
  });

  it("ignores capabilities that do not implement describeState", async () => {
    const context = await createInspectContext();

    const report = await inspectRepository(context, [
      {
        id: "master-prompt",
        async detect() {
          return { present: true, preExisting: false };
        },
        async install() {},
        async verify() {
          return { ok: true };
        },
        async uninstall() {},
      },
    ]);

    expect(report.capabilities).toEqual([]);
  });

  it("reports an adopted crg install and absent skills from the real capabilities", async () => {
    const context = await createInspectContext();
    context.run = async (command: string) =>
      command === "code-review-graph"
        ? { code: 0, stdout: "code-review-graph 1.2.3", stderr: "" }
        : { code: 1, stdout: "", stderr: "not found" };

    const report = await inspectRepository(context, [crgPlugin, skillsPlugin]);

    const crgRow = report.capabilities.find(
      (row) => row.capabilityId === "crg",
    );
    expect(crgRow?.state).toBe("present-adopted");
    const skillsRow = report.capabilities.find(
      (row) => row.capabilityId === "skills",
    );
    expect(skillsRow?.state).toBe("absent");
  });

  it("keeps the capabilities section byte-stable across repeated runs", async () => {
    const context = await createInspectContext();
    const plugins = [
      stubCapabilityPlugin("crg", [
        {
          capabilityId: "crg",
          resourceId: "package:code-review-graph",
          label: "code-review-graph",
          state: "present-managed",
          detail: "installed via pipx",
        },
      ]),
    ];

    const first = await inspectRepository(context, plugins);
    const second = await inspectRepository(context, plugins);

    expect(JSON.stringify(second.capabilities)).toBe(
      JSON.stringify(first.capabilities),
    );
  });
});

describe("runInspect", () => {
  it("prints the redacted JSON report and mutates nothing", async () => {
    const context = await createInspectContext();
    await writeFile(
      join(context.cwd, ".mcp.json"),
      '{"mcpServers":{}}',
      "utf8",
    );

    const printed: string[] = [];
    context.log = {
      log: (line: string) => printed.push(line),
      error: () => {},
    };

    await runInspect(context, { json: true });

    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]).isolation.status).toBe("no-gitignore-file");
    await expect(
      readFile(join(context.cwd, ".agemon/reports/state.json"), "utf8"),
    ).rejects.toThrow();
  });
});
