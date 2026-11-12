import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCapabilityOffers } from "../../../src/core/capability-migration.js";
import type { AgemonConfig } from "../../../src/core/config.js";
import { buildConsentGates } from "../../../src/core/consent.js";
import type { Context } from "../../../src/core/context.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import type { Plan } from "../../../src/core/plan-store.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { delegationGuardPlugin } from "../../../src/plugins/delegation-guard/index.js";
import {
  CORE_CAPABILITY_IDS,
  DEFAULT_CAPABILITY_IDS,
  getRegisteredPlugins,
} from "../../../src/plugins/index.js";
import type { ProposedOperation } from "../../../src/plugins/types.js";
import { applyAllPlanned } from "../apply-all-planned.js";
import { CLEAN_GIT_CONFIG_GUARD } from "../git-config-guard-fixture.js";
import { LINUX_TEST_PLATFORM } from "../platform-fixture.js";

const SETTINGS = ".claude/settings.json";
const SCRIPT = ".claude/hooks/agemon-delegation-guard.mjs";
const GUARD_COMMAND = {
  type: "command",
  command: `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/agemon-delegation-guard.mjs"`,
  timeout: 5,
};
const GUARD_HOOKS = {
  SessionStart: [{ matcher: "startup|clear|fork", hooks: [GUARD_COMMAND] }],
  UserPromptSubmit: [{ hooks: [GUARD_COMMAND] }],
  PreToolUse: [{ matcher: "Read|Grep|Glob|Agent", hooks: [GUARD_COMMAND] }],
};

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
  const directory = await mkdtemp(join(tmpdir(), "agemon-delegation-guard-"));
  createdTempDirectories.push(directory);
  return directory;
}

async function createTestContext(
  claudeVersion = "2.1.318",
): Promise<TestContext> {
  const cwd = await createTempDirectory();
  const binDirectory = await createTempDirectory();
  await writeFile(join(binDirectory, "claude"), "");
  await chmod(join(binDirectory, "claude"), 0o755);
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

async function writeRepoFile(
  ctx: Context,
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(join(ctx.cwd, path, ".."), { recursive: true });
  await writeFile(join(ctx.cwd, path), contents, "utf8");
}

async function readRepoFile(ctx: Context, path: string): Promise<string> {
  return readFile(join(ctx.cwd, path), "utf8");
}

async function exists(ctx: Context, path: string): Promise<boolean> {
  return lstat(join(ctx.cwd, path)).then(
    () => true,
    () => false,
  );
}

async function planFor(ctx: Context): Promise<ProposedOperation[]> {
  return (await delegationGuardPlugin.plan?.(ctx)) ?? [];
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

describe("delegation-guard offer", () => {
  it("is not in a new repo's default capabilities and is offered once through known_capabilities", () => {
    expect(delegationGuardPlugin.optIn).toBe(true);
    expect(CORE_CAPABILITY_IDS).toContain("delegation-guard");
    expect(DEFAULT_CAPABILITY_IDS).not.toContain("delegation-guard");

    const newRepoConfig = {
      capabilities: DEFAULT_CAPABILITY_IDS,
      knownCapabilities: DEFAULT_CAPABILITY_IDS,
    } as AgemonConfig;
    expect(findCapabilityOffers(newRepoConfig, getRegisteredPlugins())).toEqual(
      [{ kind: "capability", id: "delegation-guard", state: "new" }],
    );

    const afterTheOffer = {
      ...newRepoConfig,
      knownCapabilities: CORE_CAPABILITY_IDS,
    } as AgemonConfig;
    expect(findCapabilityOffers(afterTheOffer, getRegisteredPlugins())).toEqual(
      [{ kind: "capability", id: "delegation-guard", state: "declined" }],
    );
  });
});

describe("delegation-guard plan and apply", () => {
  it("plans all four resources with consent", async () => {
    const ctx = await createTestContext();

    const operations = await planFor(ctx);

    expect(operations).toMatchObject([
      { targetPath: SCRIPT, action: "create", requiresConsent: true },
      { targetPath: SETTINGS, action: "merge-key", requiresConsent: true },
    ]);
    const settingsDiff = operations[1].preview.text;
    for (const event of Object.keys(GUARD_HOOKS)) {
      expect(settingsDiff).toContain(`+    "${event}": [`);
    }
    const gates = buildConsentGates({
      plan: asPlan(operations),
      isolationStatus: "ignored",
    });
    expect(gates.map((gate) => gate.id)).toEqual(["install-hooks"]);
    expect(gates[0].operations).toHaveLength(2);
    expect(gates[0].forcesDiff).toBe(true);
    expect(gates[0].summary).toContain("run code");

    await applyAllPlanned(delegationGuardPlugin, ctx);

    expect(JSON.parse(await readRepoFile(ctx, SETTINGS))).toEqual({
      hooks: GUARD_HOOKS,
    });
    expect(await readRepoFile(ctx, SCRIPT)).toBe(
      await readFile("assets/hooks/agemon-delegation-guard.mjs", "utf8"),
    );
    expect(await delegationGuardPlugin.verify(ctx)).toMatchObject({ ok: true });
    expect(await planFor(ctx)).toEqual([]);
  });

  it("keeps a settings key another capability wrote earlier in the same run", async () => {
    const ctx = await createTestContext();
    const operations = await planFor(ctx);
    const staged = await delegationGuardPlugin.materialize?.(ctx, operations);
    const writtenEarlierInTheRun =
      '{\n  "env": {"CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"}\n}\n';
    await writeRepoFile(ctx, SETTINGS, writtenEarlierInTheRun);

    await delegationGuardPlugin.apply?.(ctx, operations, staged);

    expect(JSON.parse(await readRepoFile(ctx, SETTINGS))).toEqual({
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      hooks: GUARD_HOOKS,
    });
  });

  it("skips its hooks when the script is not being installed", async () => {
    const ctx = await createTestContext();
    const settingsOnly = (await planFor(ctx)).filter(
      (operation) => operation.targetPath === SETTINGS,
    );

    const report = await delegationGuardPlugin.apply?.(ctx, settingsOnly);

    expect(report?.skipped).toHaveLength(1);
    expect(report?.skipped[0].reason).toContain(SCRIPT);
    expect(await exists(ctx, SETTINGS)).toBe(false);
  });

  it("adds its hooks after the user's own and keeps them", async () => {
    const ctx = await createTestContext();
    const userHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "x" }],
    };
    await writeRepoFile(
      ctx,
      SETTINGS,
      `${JSON.stringify({ hooks: { PreToolUse: [userHook] } }, null, 2)}\n`,
    );

    await applyAllPlanned(delegationGuardPlugin, ctx);

    const settings = JSON.parse(await readRepoFile(ctx, SETTINGS));
    expect(settings.hooks.PreToolUse).toEqual([
      userHook,
      ...GUARD_HOOKS.PreToolUse,
    ]);
  });

  it("plans nothing and reports why when Claude Code is older than 2.1.251", async () => {
    const ctx = await createTestContext("2.1.250");

    expect(await planFor(ctx)).toEqual([]);

    const reason = ctx.infoLines.join("\n");
    expect(reason).toContain("2.1.250");
    expect(reason).toContain("2.1.251");
  });

  it("leaves a hook script that is not agemon's alone", async () => {
    const ctx = await createTestContext();
    await writeRepoFile(ctx, SCRIPT, "// the user's own guard\n");

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain("leaves it alone");
  });

  it("leaves settings it cannot change safely alone", async () => {
    const ctx = await createTestContext();
    await writeRepoFile(ctx, SETTINGS, '{ "hooks": [] }');

    expect(await planFor(ctx)).toEqual([]);

    expect(ctx.infoLines.join("\n")).toContain('"hooks" is not a JSON object');
  });
});

describe("delegation-guard revert", () => {
  it("revert removes exactly its own entries and the script", async () => {
    const ctx = await createTestContext();
    const original =
      '{\n  "permissions": {\n    "deny": ["Bash(rm:*)"]\n  },\n  "hooks": {\n    "PreToolUse": [\n      {"matcher": "Bash", "hooks": []}\n    ]\n  }\n}\n';
    await writeRepoFile(ctx, SETTINGS, original);
    await applyAllPlanned(delegationGuardPlugin, ctx);

    await delegationGuardPlugin.uninstall(ctx);

    expect(await readRepoFile(ctx, SETTINGS)).toBe(original);
    expect(await exists(ctx, SCRIPT)).toBe(false);
  });

  it.each([
    ["a full nuke", {}],
    ["nuke --only delegation-guard", { only: ["delegation-guard"] }],
  ])("is removed by %s even though it is opt-in", async (_label, options) => {
    const ctx = await createTestContext();
    await applyAllPlanned(delegationGuardPlugin, ctx);

    await uninstallPlugins(ctx, [delegationGuardPlugin], options);

    expect(await exists(ctx, SCRIPT)).toBe(false);
    expect(await exists(ctx, SETTINGS)).toBe(false);
  });

  it("a full nuke also removes the .claude/hooks directory it created", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(delegationGuardPlugin, ctx);

    await uninstallPlugins(ctx, [delegationGuardPlugin], {});

    expect(await exists(ctx, ".claude")).toBe(false);
  });

  it("removes a settings file it created", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(delegationGuardPlugin, ctx);

    await delegationGuardPlugin.uninstall(ctx);

    expect(await exists(ctx, SETTINGS)).toBe(false);
  });

  it("keeps a script the user changed", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(delegationGuardPlugin, ctx);
    await writeRepoFile(ctx, SCRIPT, "// edited\n");

    await delegationGuardPlugin.uninstall(ctx);

    expect(await readRepoFile(ctx, SCRIPT)).toBe("// edited\n");
    expect(ctx.infoLines.join("\n")).toContain(SCRIPT);
  });

  it("changes nothing in a dry run", async () => {
    const ctx = await createTestContext();
    await applyAllPlanned(delegationGuardPlugin, ctx);
    ctx.dryRun = true;

    await delegationGuardPlugin.uninstall(ctx);

    expect(await exists(ctx, SCRIPT)).toBe(true);
    expect(ctx.infoLines.join("\n")).toContain("Would remove");
  });
});
