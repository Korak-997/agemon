import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { daemonPlugin } from "../../../src/plugins/daemon/index.js";

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

/** Fakes only the `git rev-parse --show-toplevel` call the daemon plugin
 * makes to name its unit; anything else is unexpected in these tests. */
function createGitAwareRun(gitToplevel: string | undefined) {
  return async (command: string, args: string[]): Promise<SubprocessResult> => {
    if (command === "git" && args[0] === "rev-parse") {
      return gitToplevel === undefined
        ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
        : { code: 0, stdout: `${gitToplevel}\n`, stderr: "" };
    }
    throw new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
  };
}

async function createTestContext(options: {
  cwd: string;
  gitToplevel?: string;
  serviceManager: ServiceManager;
}): Promise<Context> {
  return {
    cwd: options.cwd,
    os: "ubuntu",
    binaries: [],
    dryRun: false,
    yes: true,
    confirm: async () => true,
    log: console,
    ui: createNoOpUi(),
    run: createGitAwareRun(options.gitToplevel),
    manifest: await StateManifest.load(options.cwd),
    serviceManager: options.serviceManager,
  };
}

async function createSandboxDirectory(name: string): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-daemon-test-"));
  createdTempDirectories.push(sandboxDirectory);
  return join(sandboxDirectory, name);
}

describe("daemon plugin unit naming", () => {
  it("derives the unit name from the git repository's top-level directory", async () => {
    const cwd = await createSandboxDirectory("workdir");
    const state: FakeServiceManagerState = { activeUnitNames: new Set() };
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
    const state: FakeServiceManagerState = { activeUnitNames: new Set() };
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
    const state: FakeServiceManagerState = { activeUnitNames: new Set() };
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

    // Registering repo-b must not have torn down repo-a's daemon.
    expect(await daemonPlugin.verify(repoAContext)).toEqual({
      ok: true,
      detail: "agemon-crg-daemon-repo-a.service active",
    });
  });

  it("reports the repo-scoped unit name and flags an inactive unit as unhealthy", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const state: FakeServiceManagerState = { activeUnitNames: new Set() };
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
