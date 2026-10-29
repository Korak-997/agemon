import {
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
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { applyPlan } from "../../../src/core/apply.js";
import {
  resolveImmutableBackupPath,
  writeImmutableBackup,
} from "../../../src/core/backups.js";
import { buildConsentGates } from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import { fingerprintContent } from "../../../src/core/fingerprint.js";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import {
  agentsPlugin,
  removeEmptyAgentsDirectory,
  renderAgentFile,
} from "../../../src/plugins/agents/index.js";
import { findSkillGroup } from "../../../src/plugins/skills/catalog.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const createdTempDirectories: string[] = [];
const GEO_AGENT_NAMES = [
  "geo-audit-ai-visibility",
  "geo-audit-platform",
  "geo-audit-technical",
  "geo-audit-content",
  "geo-audit-schema",
];
const BRIEF_FILE_BY_AGENT: Record<string, string> = {
  "geo-audit-ai-visibility": "ai-visibility.md",
  "geo-audit-platform": "platform-analysis.md",
  "geo-audit-technical": "technical.md",
  "geo-audit-content": "content.md",
  "geo-audit-schema": "schema.md",
};
const TECHNICAL_TARGET = ".claude/agents/geo-audit-technical.md";
const UNTRUSTED_CONTENT_HEADING = "## Untrusted content";

afterEach(async () => {
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
      return { unitPath: "", attemptLabel: "strict", failedAttempts: [] };
    },
    async unregisterAutostart() {},
    async readUnitWorkingDirectory() {
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

interface TestContext extends Context {
  infoLines: string[];
}

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdTempDirectories.push(directory);
  return directory;
}

async function createTestContext(): Promise<TestContext> {
  const sandboxDirectory = await createTempDirectory("agemon-agents-test-");
  const infoLines: string[] = [];
  return {
    infoLines,
    cwd: sandboxDirectory,
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
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      install: async () => {},
      inspect: async () => ({ kind: "absent" }),
    },
  };
}

async function recordGeoSeoGroup(context: Context): Promise<void> {
  await context.manifest.recordAction({
    plugin: "skills",
    type: "installed-skill",
    target: "geo-audit",
    preExisting: false,
  });
}

async function planFor(
  context: Context,
  plannedSoFar: ProposedOperation[] = [],
): Promise<ProposedOperation[]> {
  return (await agentsPlugin.plan?.(context, plannedSoFar)) ?? [];
}

async function readText(context: Context, target: string): Promise<string> {
  return readFile(join(context.cwd, target), "utf8");
}

async function writeText(
  context: Context,
  target: string,
  contents: string,
): Promise<void> {
  await mkdir(join(context.cwd, target, ".."), { recursive: true });
  await writeFile(join(context.cwd, target), contents, "utf8");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function technicalAgent() {
  const agent = findSkillGroup("geo-seo")?.agents?.find(
    (candidate) => candidate.name === "geo-audit-technical",
  );
  if (agent === undefined) {
    throw new Error("geo-audit-technical is missing from the catalog");
  }
  return agent;
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

function breakerOperation(template: ProposedOperation): ProposedOperation {
  return {
    ...template,
    id: "breaker:res:install",
    capabilityId: "breaker",
    resourceId: "res",
    targetPath: "res",
    action: "install-package",
    expectedFingerprint: null,
  };
}

async function applyWithBreaker(
  context: Context,
  operations: ProposedOperation[],
): Promise<void> {
  const allOperations = [...operations, breakerOperation(operations[0])];
  await expect(
    applyPlan(context, [agentsPlugin, breakerPlugin()], {
      plan: asPlan(allOperations),
      approved: allOperations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    }),
  ).rejects.toThrow(/breaker exploded/);
}

describe("agents plugin — which agents it plans", () => {
  it("plans nothing when no skill group with agents is installed or planned", async () => {
    const context = await createTestContext();
    expect(await planFor(context)).toEqual([]);
  });

  it("plans the GEO agents for a geo-seo group recorded by an older agemon", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);

    const plan = await planFor(context);

    expect(plan.map((operation) => operation.targetPath)).toEqual(
      GEO_AGENT_NAMES.map((name) => `.claude/agents/${name}.md`),
    );
    expect(plan.every((operation) => operation.action === "create")).toBe(true);
    expect(plan.every((operation) => operation.capabilityId === "agents")).toBe(
      true,
    );
  });

  it("plans the GEO agents for a geo-seo group installed by the same plan", async () => {
    const context = await createTestContext();
    const groupOperation = {
      capabilityId: "skills",
      resourceId: "skill-group:geo-seo",
      action: "install-package",
    } as ProposedOperation;

    expect(await planFor(context, [groupOperation])).toHaveLength(5);
  });

  it("ignores declines, custom groups and operations of other capabilities", async () => {
    const context = await createTestContext();
    const lookalikes = [
      {
        capabilityId: "skills",
        resourceId: "skill-group:geo-seo",
        action: "skip",
      },
      {
        capabilityId: "skills",
        resourceId: "custom-skill-group:geo-seo",
        action: "install-package",
      },
      {
        capabilityId: "crg",
        resourceId: "skill-group:geo-seo",
        action: "install-package",
      },
      {
        capabilityId: "skills",
        resourceId: "skill-group:nope",
        action: "install-package",
      },
    ] as ProposedOperation[];

    expect(await planFor(context, lookalikes)).toEqual([]);
  });

  it("plans nothing for a declined group even if one of its skills is recorded", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await context.manifest.recordAction({
      plugin: "skills",
      type: "declined-skill-group",
      target: "geo-seo",
      preExisting: false,
    });

    expect(await planFor(context)).toEqual([]);
  });
});

describe("agents plugin — file ownership", () => {
  it("creates the agent files, verifies them and removes them on nuke", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);

    await agentsPlugin.install(context);

    for (const name of GEO_AGENT_NAMES) {
      expect(await readText(context, `.claude/agents/${name}.md`)).toContain(
        `name: ${name}`,
      );
    }
    const entries = context.manifest
      .getActions()
      .filter((entry) => entry.plugin === "agents");
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({
      type: "managed-agent-file",
      preExisting: false,
      ownershipMode: "created",
      resourceId: "agent-file:geo-audit-ai-visibility",
      desiredRevision: null,
    });
    expect(await planFor(context)).toEqual([]);
    expect(await agentsPlugin.verify(context)).toEqual({
      ok: true,
      detail: "5 subagent file(s)",
    });

    await agentsPlugin.uninstall(context);

    expect(await exists(join(context.cwd, ".claude/agents"))).toBe(false);
    expect(await exists(join(context.cwd, ".claude"))).toBe(true);
  });

  it("flags a user-edited agent as a conflict and never overwrites it", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await writeText(context, TECHNICAL_TARGET, "my own technical agent\n");

    const [operation] = await planFor(context);

    expect(operation).toMatchObject({
      action: "conflict",
      targetPath: TECHNICAL_TARGET,
      expectedFingerprint: fingerprintContent("my own technical agent\n"),
    });
    await agentsPlugin.apply?.(context, [operation]);
    expect(await readText(context, TECHNICAL_TARGET)).toBe(
      "my own technical agent\n",
    );
  });

  it("replaces a user-edited agent only on a replace decision, and nuke restores the edit", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await writeText(context, TECHNICAL_TARGET, "my own technical agent\n");
    const [conflict] = await planFor(context);

    await agentsPlugin.apply?.(context, [{ ...conflict, action: "replace" }]);

    expect(await readText(context, TECHNICAL_TARGET)).toBe(
      await renderAgentFile(technicalAgent()),
    );
    expect(
      context.manifest
        .getActions()
        .filter((entry) => entry.target === TECHNICAL_TARGET),
    ).toEqual([
      expect.objectContaining({
        preExisting: true,
        fingerprintBefore: fingerprintContent("my own technical agent\n"),
      }),
    ]);

    await agentsPlugin.uninstall(context);

    expect(await readText(context, TECHNICAL_TARGET)).toBe(
      "my own technical agent\n",
    );
  });

  it("adopts an identical unrecorded agent file and keeps it on nuke", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    const desired = await renderAgentFile(technicalAgent());
    await writeText(context, TECHNICAL_TARGET, desired);

    const adoption = (await planFor(context)).find(
      (operation) => operation.targetPath === TECHNICAL_TARGET,
    );
    expect(adoption).toMatchObject({ action: "adopt" });
    await agentsPlugin.apply?.(context, adoption ? [adoption] : []);
    await agentsPlugin.uninstall(context);

    expect(await readText(context, TECHNICAL_TARGET)).toBe(desired);
  });

  it("treats a differing unrecorded agent file as a conflict", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await writeText(context, TECHNICAL_TARGET, "someone else's agent\n");

    const operation = (await planFor(context)).find(
      (candidate) => candidate.targetPath === TECHNICAL_TARGET,
    );

    expect(operation?.action).toBe("conflict");
  });

  it("upgrades an untouched agent written by an older agemon", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await writeText(context, TECHNICAL_TARGET, "older agemon template\n");
    await context.manifest.updateResourceEntry(
      "agent-file:geo-audit-technical",
      { fingerprintAfter: fingerprintContent("older agemon template\n") },
    );

    const [operation] = await planFor(context);
    expect(operation.action).toBe("replace");
    await agentsPlugin.apply?.(context, [operation]);

    expect(await readText(context, TECHNICAL_TARGET)).toBe(
      await renderAgentFile(technicalAgent()),
    );
    expect(await planFor(context)).toEqual([]);
  });

  it("skips an agent whose skill group was not installed", async () => {
    const context = await createTestContext();
    const groupOperation = {
      capabilityId: "skills",
      resourceId: "skill-group:geo-seo",
      action: "install-package",
    } as ProposedOperation;
    const operations = await planFor(context, [groupOperation]);

    await agentsPlugin.apply?.(context, operations);

    expect(await exists(join(context.cwd, ".claude"))).toBe(false);
    expect(context.manifest.getActions()).toEqual([]);
    expect(context.infoLines).toContain(
      "skipped agent geo-audit-technical: its skill group geo-seo is not installed; approve the skill group install to get it",
    );
  });

  it("refuses operations whose target, resource or action is not an agent file", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    const [create] = await planFor(context);
    const forged = [
      { ...create, targetPath: "AGENTS.md" },
      { ...create, resourceId: "agent-file:geo-audit-schema" },
      {
        ...create,
        resourceId: "agent-file:not-in-catalog",
        targetPath: ".claude/agents/not-in-catalog.md",
      },
      { ...create, action: "merge-block" as const },
    ];

    for (const operation of forged) {
      await expect(agentsPlugin.apply?.(context, [operation])).rejects.toThrow(
        /not something the agents capability does/,
      );
      await expect(
        agentsPlugin.materialize?.(context, [operation]),
      ).rejects.toThrow(/not something the agents capability does/);
    }
  });
});

describe("agents plugin — symlinks and untrusted ledgers", () => {
  it.each([
    [".claude", ".claude"],
    [".claude/agents", ".claude/agents"],
    ["an agent file", TECHNICAL_TARGET],
  ])(
    "plans a symlinked %s as a conflict it never writes through",
    async (_label, linkedPath) => {
      const context = await createTestContext();
      await recordGeoSeoGroup(context);
      const outside = await createTempDirectory("agemon-agents-outside-");
      await mkdir(join(context.cwd, linkedPath, ".."), { recursive: true });
      await symlink(outside, join(context.cwd, linkedPath));

      const operation = (await planFor(context)).find(
        (candidate) => candidate.targetPath === TECHNICAL_TARGET,
      );

      expect(operation).toMatchObject({
        action: "conflict",
        expectedFingerprint: null,
      });
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("never removes a directory through a symlinked .claude", async () => {
    const context = await createTestContext();
    const outside = await createTempDirectory("agemon-agents-outside-");
    await mkdir(join(outside, "agents"));
    await symlink(outside, join(context.cwd, ".claude"));

    await removeEmptyAgentsDirectory(context.cwd);

    expect(await exists(join(outside, "agents"))).toBe(true);
  });

  it("ignores forged ledger entries on nuke and touches nothing they name", async () => {
    const context = await createTestContext();
    await writeFile(join(context.cwd, "AGENTS.md"), "my rules\n", "utf8");
    await writeImmutableBackup(
      context.cwd,
      "rule-file:AGENTS.md",
      "rules v0\n",
    );
    const forgedTargets = [
      "../outside.md",
      ".claude/agents/../../AGENTS.md",
      ".claude/agents/not-in-catalog.md",
      "/etc/hosts",
    ];
    for (const target of forgedTargets) {
      await context.manifest.recordAction({
        plugin: "agents",
        type: "managed-agent-file",
        target,
        preExisting: false,
        resourceId: "agent-file:geo-audit-technical",
        fingerprintAfter: fingerprintContent("anything"),
      });
    }
    await writeText(context, TECHNICAL_TARGET, "planted\n");
    await context.manifest.recordAction({
      plugin: "agents",
      type: "managed-agent-file",
      target: TECHNICAL_TARGET,
      preExisting: true,
      resourceId: "rule-file:AGENTS.md",
      fingerprintBefore: fingerprintContent("rules v0\n"),
      fingerprintAfter: fingerprintContent("planted\n"),
    });

    await agentsPlugin.uninstall(context);

    expect(await readText(context, "AGENTS.md")).toBe("my rules\n");
    expect(await readText(context, TECHNICAL_TARGET)).toBe("planted\n");
    expect(
      await exists(
        resolveImmutableBackupPath(context.cwd, "rule-file:AGENTS.md"),
      ),
    ).toBe(true);
    expect(
      context.infoLines.filter((line) =>
        line.startsWith("ignoring ledger entry"),
      ),
    ).toHaveLength(5);
  });

  it("reports a recorded agent that went missing as attention, not failure", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await rm(join(context.cwd, TECHNICAL_TARGET));

    expect(await agentsPlugin.verify(context)).toMatchObject({
      ok: true,
      attention: `${TECHNICAL_TARGET} is recorded in the ledger but missing; run agemon to recreate it`,
    });
  });

  it("reports a recorded agent that turned into a symlink as attention, not failure", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await rm(join(context.cwd, TECHNICAL_TARGET));
    await symlink("/etc/hosts", join(context.cwd, TECHNICAL_TARGET));

    expect(await agentsPlugin.verify(context)).toMatchObject({
      ok: true,
      attention: `${TECHNICAL_TARGET} is not a regular file`,
    });
  });
});

describe("agents plugin — rollback", () => {
  it("removes created agents and the empty directory when a later capability fails", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);

    await applyWithBreaker(context, await planFor(context));

    expect(await exists(join(context.cwd, ".claude/agents"))).toBe(false);
    expect(
      context.manifest
        .getActions()
        .filter((entry) => entry.plugin === "agents"),
    ).toEqual([]);
    expect(context.infoLines.join("\n")).not.toContain("manual cleanup");
  });

  it("puts back the exact original after a rolled-back replace, with no copy beside it", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await agentsPlugin.install(context);
    await writeText(context, TECHNICAL_TARGET, "my own technical agent\n");
    const [conflict] = await planFor(context);

    await applyWithBreaker(context, [{ ...conflict, action: "replace" }]);

    expect(await readText(context, TECHNICAL_TARGET)).toBe(
      "my own technical agent\n",
    );
    expect(await readdir(join(context.cwd, ".claude/agents"))).toHaveLength(5);
    expect(context.infoLines.join("\n")).not.toContain("manual cleanup");
  });

  it("refuses a replace that would overwrite an earlier original, and keeps going", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await writeText(context, TECHNICAL_TARGET, "original v0\n");
    const [firstConflict] = (await planFor(context)).filter(
      (operation) => operation.targetPath === TECHNICAL_TARGET,
    );
    await agentsPlugin.apply?.(context, [
      { ...firstConflict, action: "replace" },
    ]);
    await writeText(context, TECHNICAL_TARGET, "user edit v1\n");
    const entryBefore = context.manifest
      .getActions()
      .find((entry) => entry.target === TECHNICAL_TARGET);
    const [secondConflict] = (await planFor(context)).filter(
      (operation) => operation.targetPath === TECHNICAL_TARGET,
    );

    await agentsPlugin.apply?.(context, [
      { ...secondConflict, action: "replace" },
    ]);

    expect(await readText(context, TECHNICAL_TARGET)).toBe("user edit v1\n");
    expect(
      await readFile(
        resolveImmutableBackupPath(
          context.cwd,
          "agent-file:geo-audit-technical",
        ),
        "utf8",
      ),
    ).toBe("original v0\n");
    expect(
      context.manifest
        .getActions()
        .find((entry) => entry.target === TECHNICAL_TARGET),
    ).toEqual(entryBefore);
    expect(context.infoLines.at(-1)).toMatch(
      /^skipped \.claude\/agents\/geo-audit-technical\.md: agemon already keeps an earlier original of it at \.agemon\/backups\//,
    );
  });
});

describe("agents plugin — consent gate", () => {
  async function subagentGate(operations: ProposedOperation[]) {
    return buildConsentGates({
      plan: asPlan(operations),
      isolationStatus: "ignored",
    }).find((gate) => gate.id === "install-subagents");
  }

  it("lists every agent with its tools in the gate and its --yes announcement", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);

    const gate = await subagentGate(await planFor(context));

    expect(gate?.summary).toContain(
      "geo-audit-technical [tools: WebFetch, Bash]",
    );
    expect(gate?.summary).toContain("geo-audit-content [tools: WebFetch]");
    expect(gate?.announcementWithYes).toMatch(
      /^Installing 5 Claude Code subagent/,
    );
    expect(gate?.forcesDiff).toBe(false);
  });

  it("shows agemon's tools, not the replaced file's, for a conflict resolved as replace", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await writeText(
      context,
      TECHNICAL_TARGET,
      "---\nname: geo-audit-technical\ntools: Read, Write, Bash\n---\n\nbody\ntools: Everything\n",
    );
    const conflict = (await planFor(context)).find(
      (operation) => operation.targetPath === TECHNICAL_TARGET,
    );

    const gate = await subagentGate(
      conflict ? [{ ...conflict, action: "replace" }] : [],
    );

    expect(gate?.summary).toContain(
      "geo-audit-technical [tools: WebFetch, Bash]",
    );
    expect(gate?.summary).not.toContain("Read, Write");
  });

  it("reads tools only from the frontmatter of the new file, never from its body", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    const [create] = await planFor(context);
    const withBodyToolsLine = {
      ...create,
      preview: {
        kind: "diff" as const,
        text: "--- a\n+++ a\n+---\n+name: x\n+tools: WebFetch\n+---\n+\n+tools: Read, Write, Bash\n",
      },
    };

    const gate = await subagentGate([withBodyToolsLine]);

    expect(gate?.summary).toContain("[tools: WebFetch]");
    expect(gate?.summary).not.toContain("Read, Write");
  });

  it("says nothing is written for an adoption, and 'unknown' for an unreadable preview", async () => {
    const context = await createTestContext();
    await recordGeoSeoGroup(context);
    await writeText(
      context,
      TECHNICAL_TARGET,
      await renderAgentFile(technicalAgent()),
    );
    const operations = await planFor(context);
    const adoption = operations.find(
      (operation) => operation.action === "adopt",
    );
    const garbled = {
      ...operations[0],
      preview: {
        kind: "diff" as const,
        text: "--- a\n+++ a\n+no frontmatter\n",
      },
    };

    const gate = await subagentGate([...(adoption ? [adoption] : []), garbled]);

    expect(gate?.summary).toContain(
      "geo-audit-technical (already identical; nothing written)",
    );
    expect(gate?.summary).toContain("tools: unknown — see diff");
  });
});

describe("GEO agent catalog", () => {
  const agents = findSkillGroup("geo-seo")?.agents ?? [];

  it("declares the five audit agents", () => {
    expect(agents.map((agent) => agent.name)).toEqual(GEO_AGENT_NAMES);
  });

  it.each(GEO_AGENT_NAMES)(
    "renders %s with exactly name, description and tools",
    async (name) => {
      const agent = agents.find((candidate) => candidate.name === name);
      if (agent === undefined) {
        throw new Error(`${name} missing`);
      }
      const rendered = await renderAgentFile(agent);
      const [, frontmatterText, body] =
        /^---\n([\s\S]*?)---\n\n([\s\S]*)$/u.exec(rendered) ?? [];
      const frontmatter = parseYaml(frontmatterText);

      expect(Object.keys(frontmatter)).toEqual([
        "name",
        "description",
        "tools",
      ]);
      expect(frontmatter.name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
      expect(typeof frontmatter.tools).toBe("string");
      expect(frontmatter.tools.split(", ")).toEqual(agent.tools);
      expect(
        agent.tools.every((tool) => ["WebFetch", "Bash"].includes(tool)),
      ).toBe(true);
      expect(agent.tools.includes("Bash")).toBe(
        name === "geo-audit-technical" || name === "geo-audit-schema",
      );
      expect(frontmatter.description).toMatch(
        /Used by the geo-audit skill; do not use it for other tasks\.$/u,
      );
      const frontmatterLines = frontmatterText.trimEnd().split("\n");
      expect(frontmatterLines).toHaveLength(3);
      expect(body.startsWith(UNTRUSTED_CONTENT_HEADING)).toBe(true);
      expect(body).toBe(
        await readFile(
          join(
            resolveVendoredSkillPath("geo-seo", "geo-audit"),
            "references",
            BRIEF_FILE_BY_AGENT[name],
          ),
          "utf8",
        ),
      );
    },
  );
});

describe("geo-audit launches the installed agents", () => {
  const skillPath = join(
    resolveVendoredSkillPath("geo-seo", "geo-audit"),
    "SKILL.md",
  );

  it("names every agent with its catalog tools and its fallback brief", async () => {
    const skill = await readFile(skillPath, "utf8");
    const agents = findSkillGroup("geo-seo")?.agents ?? [];

    for (const agent of agents) {
      expect(skill).toContain(
        `| \`${agent.name}\` | ${agent.tools.join(", ")} | \`\${CLAUDE_SKILL_DIR}/references/${BRIEF_FILE_BY_AGENT[agent.name]}\` |`,
      );
    }
    expect(skill).toContain(
      "If the Agent tool rejects one of these `subagent_type` values",
    );
  });

  it("no longer uses the old subagent labels that clash with skill names", async () => {
    const skill = await readFile(skillPath, "utf8");

    for (const oldLabel of [
      "(geo-ai-visibility)",
      "(geo-platform-analysis)",
      "(geo-technical)",
      "(geo-content)",
      "(geo-schema)",
      "as **general-purpose subagents**",
    ]) {
      expect(skill).not.toContain(oldLabel);
    }
  });
});
