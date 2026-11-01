import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { agentsPlugin } from "../../../src/plugins/agents/index.js";
import { describeOperation } from "../../../src/plugins/proposed-operation.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const RETIRED_NAME = "geo-audit-retired";
const RETIRED_TARGET = `.claude/agents/${RETIRED_NAME}.md`;
const RETIRED_CONTENTS = "---\nname: geo-audit-retired\n---\n\nold brief\n";

vi.mock("../../../src/plugins/skills/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/plugins/skills/catalog.js")
  >()),
  RETIRED_AGENT_NAMES: ["geo-audit-retired"],
}));

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

const unusedServiceManager = {} as ServiceManager;

async function createTestContext(): Promise<Context & { infoLines: string[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-agents-retired-"));
  createdTempDirectories.push(cwd);
  const infoLines: string[] = [];
  return {
    infoLines,
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
    ui: {
      start() {},
      succeed() {},
      fail() {},
      info(message: string) {
        infoLines.push(message);
      },
    },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(cwd),
    serviceManager: unusedServiceManager,
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

async function installAgentFile(
  context: Context,
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(join(context.cwd, ".claude/agents"), { recursive: true });
  await writeFile(join(context.cwd, `.claude/agents/${name}.md`), contents);
  await context.manifest.recordAction({
    plugin: "agents",
    type: "managed-agent-file",
    target: `.claude/agents/${name}.md`,
    preExisting: false,
    resourceId: `agent-file:${name}`,
    ownershipMode: "created",
    fingerprintBefore: null,
    fingerprintAfter: fingerprintContent(contents),
  });
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe("agents plugin — retired agent names", () => {
  it("nuke reverts a confirmed entry for a retired agent name", async () => {
    const context = await createTestContext();
    await installAgentFile(context, RETIRED_NAME, RETIRED_CONTENTS);

    await agentsPlugin.uninstall(context);

    expect(await exists(join(context.cwd, RETIRED_TARGET))).toBe(false);
  });

  it("nuke ignores an entry whose name is neither current nor retired", async () => {
    const context = await createTestContext();
    await installAgentFile(context, "never-shipped", RETIRED_CONTENTS);

    await agentsPlugin.uninstall(context);

    expect(
      await exists(join(context.cwd, ".claude/agents/never-shipped.md")),
    ).toBe(true);
    expect(context.infoLines).toContain(
      "ignoring ledger entry for .claude/agents/never-shipped.md: the agents capability does not manage that file",
    );
  });

  it("a retired name is never planned or accepted in a plan operation", async () => {
    const context = await createTestContext();
    await context.manifest.recordAction({
      plugin: "skills",
      type: "installed-skill",
      target: "geo-audit",
      preExisting: false,
    });
    const planned = (await agentsPlugin.plan?.(context, [])) ?? [];
    const retiredOperation = describeOperation({
      capabilityId: "agents",
      resourceId: `agent-file:${RETIRED_NAME}`,
      targetPath: RETIRED_TARGET,
      action: "create",
      riskClass: "writes-config",
      requiresConsent: true,
      preview: { kind: "note", text: "" },
    });

    expect(planned.map((operation) => operation.targetPath)).not.toContain(
      RETIRED_TARGET,
    );
    await expect(
      agentsPlugin.materialize?.(context, [retiredOperation]),
    ).rejects.toThrow("is not something the agents capability does");
  });

  it("status lists no row for a retired agent whose file is gone", async () => {
    const context = await createTestContext();
    await installAgentFile(context, RETIRED_NAME, RETIRED_CONTENTS);
    await rm(join(context.cwd, RETIRED_TARGET));

    expect((await agentsPlugin.describeState?.(context)) ?? []).toEqual([]);
  });

  it("status lists a recorded retired agent and how nuke removes it", async () => {
    const context = await createTestContext();
    await installAgentFile(context, RETIRED_NAME, RETIRED_CONTENTS);

    const rows = (await agentsPlugin.describeState?.(context)) ?? [];

    expect(rows).toContainEqual({
      capabilityId: "agents",
      resourceId: `agent-file:${RETIRED_NAME}`,
      label: RETIRED_NAME,
      state: "present-managed",
      detail:
        "agemon no longer ships this agent; 'agemon nuke --only agents' removes it",
    });
  });
});
