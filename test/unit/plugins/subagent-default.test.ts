import {
  chmod,
  lstat,
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
import { applyPlan } from "../../../src/core/apply.js";
import { buildConsentGates } from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { subagentDefaultPlugin } from "../../../src/plugins/subagent-default/index.js";
import type {
  AgemonPlugin,
  ProposedOperation,
} from "../../../src/plugins/types.js";
import { applyAllPlanned } from "../apply-all-planned.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { appendLedgerClaims } from "../ledger-claims.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const SETTINGS = ".claude/settings.json";
const KEY = "CLAUDE_CODE_SUBAGENT_MODEL";
const RESOURCE_ID = `settings-key:env.${KEY}`;
const CREATED_SETTINGS = `{\n  "env": {\n    "${KEY}": "sonnet"\n  }\n}\n`;
const NO_CLAUDE_ON_PATH = "no-claude-on-path";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface TestContext extends Context {
  infoLines: string[];
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-subagent-default-"));
  createdTempDirectories.push(directory);
  return directory;
}

async function createTestContext(
  claudeVersion: string = "2.1.318",
): Promise<TestContext> {
  const cwd = await createTempDirectory();
  const binDirectory = await createTempDirectory();
  if (claudeVersion !== NO_CLAUDE_ON_PATH) {
    await writeFile(join(binDirectory, "claude"), "");
    await chmod(join(binDirectory, "claude"), 0o755);
  }
  vi.stubEnv("PATH", binDirectory);
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
    run: async () => ({
      code: 0,
      stdout: `${claudeVersion} (Claude Code)\n`,
      stderr: "",
    }),
    manifest: await StateManifest.load(cwd),
  } as unknown as TestContext;
}

async function writeSettings(ctx: Context, contents: string): Promise<void> {
  await mkdir(join(ctx.cwd, ".claude"), { recursive: true });
  await writeFile(join(ctx.cwd, SETTINGS), contents, "utf8");
}

async function readSettings(ctx: Context): Promise<string> {
  return readFile(join(ctx.cwd, SETTINGS), "utf8");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function planFor(ctx: Context): Promise<ProposedOperation[]> {
  return (await subagentDefaultPlugin.plan?.(ctx)) ?? [];
}

async function stateRow(ctx: Context) {
  const rows = (await subagentDefaultPlugin.describeState?.(ctx)) ?? [];
  expect(rows).toHaveLength(1);
  return rows[0];
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

describe("subagent-default plan", () => {
  it("proposes one merge that needs consent and shows the diff", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, '{\n  "hooks": {}\n}\n');

    const operations = await planFor(ctx);

    expect(operations).toHaveLength(1);
    const [operation] = operations;
    expect(operation).toMatchObject({
      action: "merge-key",
      targetPath: SETTINGS,
      resourceId: RESOURCE_ID,
      requiresConsent: true,
      riskClass: "writes-config",
    });
    expect(operation.preview.kind).toBe("diff");
    expect(operation.preview.text).toContain(`+    "${KEY}": "sonnet"`);
    const gates = buildConsentGates({
      plan: asPlan(operations),
      isolationStatus: "ignored",
    });
    expect(gates.map((gate) => gate.id)).toEqual(["write-config"]);
    expect(gates[0].forcesDiff).toBe(true);
    expect(gates[0].announcementWithYes).toContain(SETTINGS);
    expect(gates[0].announcementWithYes).toContain(`+    "${KEY}": "sonnet"`);
  });

  it("refuses a file with bytes it could not write back unchanged", async () => {
    const ctx = await createTestContext();
    const latin1Bytes = Buffer.from('{ "hook": "caf\xe9" }\n', "latin1");
    await mkdir(join(ctx.cwd, ".claude"));
    await writeFile(join(ctx.cwd, SETTINGS), latin1Bytes);

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("UTF-8");
    expect(await readFile(join(ctx.cwd, SETTINGS))).toEqual(latin1Bytes);
    expect((await stateRow(ctx)).state).toBe("unknown");
  });

  it.each(["2.1.251", "2.1.318", "2.2.0", "10.0.0"])(
    "plans on supported CLI %s",
    async (version) => {
      const ctx = await createTestContext(version);

      expect(await planFor(ctx)).toHaveLength(1);
    },
  );

  it.each(["2.1.250", "2.1.99", "1.9.999"])(
    "writes nothing on CLI %s, where the default overrides pinned models, and says why",
    async (version) => {
      const ctx = await createTestContext(version);

      expect(await planFor(ctx)).toEqual([]);

      const reason = ctx.infoLines.join("\n");
      expect(reason).toContain(version);
      expect(reason).toContain("2.1.251");
      expect(reason).toContain("override");
      expect((await stateRow(ctx)).detail).toContain("2.1.251");
    },
  );

  it("writes nothing when Claude Code is not on the PATH, and says why", async () => {
    const ctx = await createTestContext(NO_CLAUDE_ON_PATH);

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("could not read");
  });

  it("writes nothing when the version probe fails", async () => {
    const ctx = await createTestContext();
    ctx.run = async () => ({ code: 1, stdout: "", stderr: "boom" });

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("could not read");
  });

  it("leaves a user's own value alone without asking", async () => {
    const ctx = await createTestContext();
    const original = `{ "env": { "${KEY}": "haiku" } }`;
    await writeSettings(ctx, original);

    expect(await planFor(ctx)).toEqual([]);

    expect(await readSettings(ctx)).toBe(original);
    expect(await stateRow(ctx)).toMatchObject({
      state: "present-modified",
    });
    expect((await stateRow(ctx)).detail).toContain("yours");
  });

  it("plans nothing when the value is already agemon's default", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, `{ "env": { "${KEY}": "sonnet" } }`);

    expect(await planFor(ctx)).toEqual([]);

    expect((await stateRow(ctx)).state).toBe("present-adopted");
  });

  it("reports invalid JSON and leaves it untouched", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, "{ not json");

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("not valid JSON");
    expect(await readSettings(ctx)).toBe("{ not json");
    expect((await stateRow(ctx)).state).toBe("unknown");
  });

  it("refuses a symlinked settings file", async () => {
    const ctx = await createTestContext();
    const elsewhere = join(await createTempDirectory(), "settings.json");
    await writeFile(elsewhere, "{}\n");
    await mkdir(join(ctx.cwd, ".claude"));
    await symlink(elsewhere, join(ctx.cwd, SETTINGS));

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("leaves it alone");
    expect(await readFile(elsewhere, "utf8")).toBe("{}\n");
    expect((await stateRow(ctx)).state).toBe("unknown");
  });
});

describe("subagent-default apply", () => {
  it("stages valid JSON, writes the key, and records the key and value", async () => {
    const ctx = await createTestContext();
    const original = '{\n  "hooks": {}\n}\n';
    await writeSettings(ctx, original);
    const operations = await planFor(ctx);

    const staged = await subagentDefaultPlugin.materialize?.(ctx, operations);
    expect(staged).toMatchObject([{ targetPath: SETTINGS, kind: "json" }]);
    await subagentDefaultPlugin.apply?.(ctx, operations, staged);

    expect(JSON.parse(await readSettings(ctx))).toEqual({
      hooks: {},
      env: { [KEY]: "sonnet" },
    });
    const [entry] = ctx.manifest
      .getActions()
      .filter(({ plugin }) => plugin === "subagent-default");
    expect(entry).toMatchObject({
      target: SETTINGS,
      resourceId: RESOURCE_ID,
      desiredRevision: "sonnet",
      ownershipMode: "recorded-key",
      preExisting: true,
    });
    expect(await subagentDefaultPlugin.verify(ctx)).toMatchObject({ ok: true });
    expect(await planFor(ctx)).toEqual([]);
    expect((await stateRow(ctx)).state).toBe("present-managed");
  });

  it("creates .claude and records the directory it created", async () => {
    const ctx = await createTestContext();

    await applyAllPlanned(subagentDefaultPlugin, ctx);

    expect(await readSettings(ctx)).toBe(CREATED_SETTINGS);
    expect(
      ctx.manifest
        .getActions()
        .filter(({ type }) => type === "created-directory")
        .map(({ target }) => target),
    ).toEqual([".claude"]);
  });

  it("offers the key again after the user removed it, without a second ledger entry", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, "{}\n");
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    await writeSettings(ctx, "{}\n");

    expect((await subagentDefaultPlugin.verify(ctx)).attention).toContain(KEY);

    await applyAllPlanned(subagentDefaultPlugin, ctx);

    expect(
      ctx.manifest
        .getActions()
        .filter(({ plugin }) => plugin === "subagent-default"),
    ).toHaveLength(1);
  });

  it("restores the file when a later capability fails", async () => {
    const ctx = await createTestContext();
    const original = '{\n  "env": {}\n}\n';
    await writeSettings(ctx, original);
    const operations = await planFor(ctx);
    const breaker: AgemonPlugin = {
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
    const breakerOperation: ProposedOperation = {
      ...operations[0],
      id: "breaker:res:install",
      capabilityId: "breaker",
      resourceId: "breaker-res",
      targetPath: "",
      action: "install-package",
    };
    const plan = asPlan([...operations, breakerOperation]);

    await expect(
      applyPlan(ctx, [subagentDefaultPlugin, breaker], {
        plan,
        approved: plan.operations,
        workspaceIsolationApproved: null,
        isolationStatus: "ignored",
        allowUnignoredState: false,
      }),
    ).rejects.toThrow("breaker exploded");

    expect(await readSettings(ctx)).toBe(original);
  });
});

describe("subagent-default nuke", () => {
  it("restores this repo's settings byte for byte", async () => {
    const ctx = await createTestContext();
    const original = await readFile(SETTINGS, "utf8");
    await writeSettings(ctx, original);
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    expect(await readSettings(ctx)).not.toBe(original);

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe(original);
  });

  it("removes a settings file agemon created", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(subagentDefaultPlugin, ctx);

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await exists(join(ctx.cwd, SETTINGS))).toBe(false);
  });

  it("keeps a settings file agemon created once the user added to it", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    await writeSettings(
      ctx,
      `{\n  "model": "opus",\n  "env": {\n    "${KEY}": "sonnet"\n  }\n}\n`,
    );

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe('{\n  "model": "opus"\n}\n');
  });

  it("keeps an empty settings file that was there before agemon", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, "{}\n");
    await applyAllPlanned(subagentDefaultPlugin, ctx);

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe("{}\n");
  });

  it("keeps a value the user changed and reports it as theirs", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    const changed = CREATED_SETTINGS.replace("sonnet", "haiku");
    await writeSettings(ctx, changed);

    expect(await stateRow(ctx)).toMatchObject({ state: "present-modified" });
    expect((await stateRow(ctx)).detail).toContain("yours");

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe(changed);
    expect(ctx.infoLines.join("\n")).toContain("haiku");
  });

  it("leaves a value agemon did not write", async () => {
    const ctx = await createTestContext();
    const original = `{ "env": { "${KEY}": "sonnet" } }`;
    await writeSettings(ctx, original);
    await applyAllPlanned(subagentDefaultPlugin, ctx);

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe(original);
  });

  it("ignores a ledger entry this machine did not write", async () => {
    const ctx = await createTestContext();
    await writeSettings(ctx, CREATED_SETTINGS);
    await appendLedgerClaims(ctx, [
      {
        plugin: "subagent-default",
        type: "managed-settings-key",
        target: SETTINGS,
        preExisting: false,
        resourceId: RESOURCE_ID,
        desiredRevision: "sonnet",
      },
    ]);

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe(CREATED_SETTINGS);
    expect(ctx.infoLines.join("\n")).toContain("did not write it");
  });

  it("does not touch invalid JSON, and asks for cleanup", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    await writeSettings(ctx, "{ broken");

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe("{ broken");
    expect(ctx.infoLines.join("\n")).toContain("manual cleanup needed");
  });

  it("changes nothing in a dry run", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(subagentDefaultPlugin, ctx);
    ctx.dryRun = true;

    await subagentDefaultPlugin.uninstall(ctx);

    expect(await readSettings(ctx)).toBe(CREATED_SETTINGS);
    expect(ctx.infoLines.join("\n")).toContain("Would remove");
  });
});
