import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { installPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import type {
  AgemonPlugin,
  PluginPresence,
  PluginVerificationResult,
} from "../../../src/plugins/types.js";

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

interface RecordedUiCall {
  type: "start" | "succeed" | "fail" | "info";
  label?: string;
}

function createRecordingUi(): { ui: Context["ui"]; calls: RecordedUiCall[] } {
  const calls: RecordedUiCall[] = [];
  return {
    calls,
    ui: {
      start(label) {
        calls.push({ type: "start", label });
      },
      succeed(label) {
        calls.push({ type: "succeed", label });
      },
      fail(label) {
        calls.push({ type: "fail", label });
      },
      info(label) {
        calls.push({ type: "info", label });
      },
    },
  };
}

async function createTestContext(overrides: {
  ui: Context["ui"];
  dryRun?: boolean;
  yes?: boolean;
  confirm: (message: string) => Promise<boolean>;
}): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-orchestrator-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  return {
    cwd: sandboxDirectory,
    os: "ubuntu",
    binaries: [],
    dryRun: overrides.dryRun ?? false,
    yes: overrides.yes ?? false,
    log: console,
    ui: overrides.ui,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    confirm: overrides.confirm,
  };
}

interface FakePluginOptions {
  id: string;
  presence: PluginPresence;
  /**
   * Results returned by successive `verify()` calls. Once exhausted, the
   * last entry keeps being returned (mirrors "still broken after a fix
   * attempt" as well as "stayed healthy" scenarios without extra bookkeeping
   * in each test).
   */
  verifyResults: PluginVerificationResult[];
}

function createFakePlugin(options: FakePluginOptions): {
  plugin: AgemonPlugin;
  installCallCount: () => number;
} {
  let installCalls = 0;
  const verifyResults = [...options.verifyResults];

  return {
    installCallCount: () => installCalls,
    plugin: {
      id: options.id,
      async detect() {
        return options.presence;
      },
      async install() {
        installCalls += 1;
      },
      async verify() {
        return verifyResults.length > 1
          ? (verifyResults.shift() as PluginVerificationResult)
          : verifyResults[0];
      },
      async uninstall() {
        return;
      },
    },
  };
}

describe("installPlugins", () => {
  it("runs a fresh install when a plugin is not detected", async () => {
    const { ui, calls } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => {
        throw new Error("should not prompt during a fresh install");
      },
    });
    const { plugin, installCallCount } = createFakePlugin({
      id: "fresh",
      presence: { present: false, preExisting: false },
      verifyResults: [{ ok: true, detail: "all good" }],
    });

    await installPlugins(context, [plugin], {});

    expect(installCallCount()).toBe(1);
    expect(
      calls.some(
        (call) =>
          call.type === "succeed" &&
          call.label === "Installed fresh (all good)",
      ),
    ).toBe(true);
  });

  it("appends .agemon to an existing .gitignore after installation", async () => {
    const { ui } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => false,
    });
    await writeFile(join(context.cwd, ".gitignore"), "dist\n", "utf8");
    const { plugin } = createFakePlugin({
      id: "fresh",
      presence: { present: false, preExisting: false },
      verifyResults: [{ ok: true }],
    });

    await installPlugins(context, [plugin], {});

    await expect(
      readFile(join(context.cwd, ".gitignore"), "utf8"),
    ).resolves.toBe("dist\n.agemon\n");
  });

  it("does not create or modify .gitignore when it is absent or dry-running", async () => {
    const { ui } = createRecordingUi();
    const context = await createTestContext({
      ui,
      dryRun: true,
      confirm: async () => false,
    });
    const { plugin } = createFakePlugin({
      id: "fresh",
      presence: { present: false, preExisting: false },
      verifyResults: [{ ok: true }],
    });

    await installPlugins(context, [plugin], {});

    await expect(
      readFile(join(context.cwd, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not duplicate an existing .agemon entry", async () => {
    const { ui } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => false,
    });
    const gitignorePath = join(context.cwd, ".gitignore");
    await writeFile(gitignorePath, "dist\n.agemon\n", "utf8");
    const { plugin } = createFakePlugin({
      id: "fresh",
      presence: { present: false, preExisting: false },
      verifyResults: [{ ok: true }],
    });

    await installPlugins(context, [plugin], {});

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(
      "dist\n.agemon\n",
    );
  });

  it("skips a healthy, already-present plugin without reinstalling or prompting", async () => {
    const { ui, calls } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => {
        throw new Error("should not prompt when already healthy");
      },
    });
    const { plugin, installCallCount } = createFakePlugin({
      id: "healthy",
      presence: { present: true, preExisting: false },
      verifyResults: [{ ok: true, detail: "status command passed" }],
    });

    await installPlugins(context, [plugin], {});

    expect(installCallCount()).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.type === "succeed" &&
          call.label === "Already installed healthy (status command passed)",
      ),
    ).toBe(true);
  });

  it("fixes an unhealthy present plugin once the user confirms", async () => {
    const { ui } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => true,
    });
    const { plugin, installCallCount } = createFakePlugin({
      id: "broken",
      presence: { present: true, preExisting: false },
      verifyResults: [
        { ok: false, detail: "unit is not active" },
        { ok: true, detail: "unit active" },
      ],
    });

    await installPlugins(context, [plugin], {});

    expect(installCallCount()).toBe(1);
  });

  it("leaves an unhealthy plugin alone when the user declines to fix it", async () => {
    const { ui, calls } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => false,
    });
    const { plugin, installCallCount } = createFakePlugin({
      id: "broken",
      presence: { present: true, preExisting: false },
      verifyResults: [{ ok: false, detail: "unit is not active" }],
    });

    await installPlugins(context, [plugin], {});

    expect(installCallCount()).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.type === "fail" && call.label?.includes("Left broken as-is"),
      ),
    ).toBe(true);
  });

  it("throws when a confirmed fix attempt is still unhealthy afterward", async () => {
    const { ui } = createRecordingUi();
    const context = await createTestContext({
      ui,
      confirm: async () => true,
    });
    const { plugin } = createFakePlugin({
      id: "still-broken",
      presence: { present: true, preExisting: false },
      verifyResults: [
        { ok: false, detail: "unit is not active" },
        { ok: false, detail: "still not active" },
      ],
    });

    await expect(installPlugins(context, [plugin], {})).rejects.toThrow(
      "still not active",
    );
  });
});
