import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { daemonPlugin } from "../../../src/plugins/daemon/index.js";
import { CODE_REVIEW_GRAPH_VERSION } from "../../../src/plugins/pins.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

function createNoOpUi(): Context["ui"] {
  return {
    start() {
      return;
    },
    succeed() {
      return;
    },
    fail() {
      return;
    },
    info() {
      return;
    },
  };
}

interface FakeServiceManagerState {
  activeUnitNames: Set<string>;
  unitContentsByName: Map<string, string>;
}

function createFakeServiceManager(
  state: FakeServiceManagerState,
): ServiceManager {
  return {
    async isActive(unitName) {
      return { active: state.activeUnitNames.has(unitName) };
    },
    async registerAutostart(input) {
      state.activeUnitNames.add(input.unitName);
      state.unitContentsByName.set(input.unitName, input.unitContents);
      return {
        unitPath: `/fake/systemd/user/${input.unitName}`,
        lingerEnabledByAgemon: true,
      };
    },
    async unregisterAutostart(input) {
      state.activeUnitNames.delete(input.unitName);
    },
  };
}

const DEFAULT_CRG_EXECUTABLE_PATH = "/home/dani/.local/bin/code-review-graph";
function createGitAwareRun(
  gitToplevel: string | undefined,
  crgExecutablePath: string | undefined,
) {
  return async (command: string, args: string[]): Promise<SubprocessResult> => {
    if (command === "git" && args[0] === "rev-parse") {
      return gitToplevel === undefined
        ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
        : { code: 0, stdout: `${gitToplevel}\n`, stderr: "" };
    }
    if (command === "which" && args[0] === "code-review-graph") {
      return crgExecutablePath === undefined
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${crgExecutablePath}\n`, stderr: "" };
    }
    throw new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
  };
}
async function createTestContext(options: {
  cwd: string;
  gitToplevel?: string;
  crgExecutablePath?: string | null;
  serviceManager: ServiceManager;
}): Promise<Context> {
  const crgExecutablePath =
    options.crgExecutablePath === undefined
      ? DEFAULT_CRG_EXECUTABLE_PATH
      : (options.crgExecutablePath ?? undefined);

  return {
    cwd: options.cwd,
    os: "ubuntu",
    binaries: [],
    dryRun: false,
    yes: true,
    interactive: false,
    confirm: async () => true,
    consent: async () => ({
      approved: [],
      skipped: [],
      workspaceIsolationApproved: null,
      conflictResolutions: [],
    }),
    log: console,
    ui: createNoOpUi(),
    run: createGitAwareRun(options.gitToplevel, crgExecutablePath),
    manifest: await StateManifest.load(options.cwd),
    serviceManager: options.serviceManager,
    verifiedBinaryInstaller: { install: async () => {} },
  };
}

async function createSandboxDirectory(name: string): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-daemon-test-"));
  createdTempDirectories.push(sandboxDirectory);
  const repoDirectory = join(sandboxDirectory, name);
  await mkdir(repoDirectory);
  return repoDirectory;
}

describe("daemon plugin unit naming", () => {
  it("derives the unit name from the git repository's top-level directory", async () => {
    const cwd = await createSandboxDirectory("workdir");
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const context = await createTestContext({
      cwd,
      gitToplevel: "/home/dani/dev/My Cool Repo!!",
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(context);

    expect([...state.activeUnitNames]).toEqual([
      "agemon-crg-daemon-my-cool-repo.service",
    ]);
  });

  it("falls back to the working directory's basename outside a git repository", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const context = await createTestContext({
      cwd,
      gitToplevel: undefined,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(context);

    expect([...state.activeUnitNames]).toEqual([
      "agemon-crg-daemon-loyl.service",
    ]);
  });

  it("keeps two repos' daemons independent instead of colliding on one shared name", async () => {
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const serviceManager = createFakeServiceManager(state);

    const repoAContext = await createTestContext({
      cwd: await createSandboxDirectory("repo-a"),
      gitToplevel: "/home/dani/dev/repo-a",
      serviceManager,
    });
    const repoBContext = await createTestContext({
      cwd: await createSandboxDirectory("repo-b"),
      gitToplevel: "/home/dani/dev/repo-b",
      serviceManager,
    });

    await daemonPlugin.install(repoAContext);
    await daemonPlugin.install(repoBContext);

    expect([...state.activeUnitNames].sort()).toEqual([
      "agemon-crg-daemon-repo-a.service",
      "agemon-crg-daemon-repo-b.service",
    ]);
    expect(await daemonPlugin.verify(repoAContext)).toEqual({
      ok: true,
      detail: "agemon-crg-daemon-repo-a.service active",
    });
  });

  it("reports the repo-scoped unit name and flags an inactive unit as unhealthy", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const context = await createTestContext({
      cwd,
      gitToplevel: undefined,
      serviceManager: createFakeServiceManager(state),
    });

    const result = await daemonPlugin.verify(context);

    expect(result).toEqual({
      ok: false,
      detail: "agemon-crg-daemon-loyl.service is not active",
    });
  });
});

describe("daemon plugin ExecStart resolution", () => {
  it("bakes the absolute code-review-graph path into ExecStart instead of a bare command name", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const context = await createTestContext({
      cwd,
      gitToplevel: undefined,
      crgExecutablePath: "/home/dani/.local/bin/code-review-graph",
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(context);

    const unitContents = state.unitContentsByName.get(
      "agemon-crg-daemon-loyl.service",
    );
    expect(unitContents).toContain(
      "ExecStart=/home/dani/.local/bin/code-review-graph watch",
    );
  });

  it("fails install with a clear error when code-review-graph can't be resolved on PATH", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const state: FakeServiceManagerState = {
      activeUnitNames: new Set(),
      unitContentsByName: new Map(),
    };
    const context = await createTestContext({
      cwd,
      gitToplevel: undefined,
      crgExecutablePath: null,
      serviceManager: createFakeServiceManager(state),
    });

    const installError = await daemonPlugin
      .install(context)
      .catch((error: unknown) => error);
    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).toMatch(
      /Unable to resolve an absolute path for 'code-review-graph'/,
    );
    expect((installError as Error).message).toContain(
      `pipx install code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`,
    );
  });
});

describe("daemon plugin detection", () => {
  it("daemon detect writes nothing to the ledger", async () => {
    const repoDirectory = await createSandboxDirectory("adopted");
    const serviceState: FakeServiceManagerState = {
      activeUnitNames: new Set(["agemon-crg-daemon-adopted.service"]),
      unitContentsByName: new Map(),
    };
    const ctx = await createTestContext({
      cwd: repoDirectory,
      serviceManager: createFakeServiceManager(serviceState),
    });

    const presence = await daemonPlugin.detect(ctx);

    expect(presence).toEqual({ present: true, preExisting: true });
    expect(ctx.manifest.getActions()).toEqual([]);
  });
});
