import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyRollbackError, applyPlan } from "../../../src/core/apply.js";
import type { Context } from "../../../src/core/context.js";
import { NotARegularFileError } from "../../../src/core/files.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import type {
  AutostartAttempt,
  ServiceManager,
  UnregisterAutostartInput,
} from "../../../src/platform/service-manager/index.js";
import { workingDirectoryOfUnit } from "../../../src/platform/service-manager/unit-files.js";
import { daemonPlugin } from "../../../src/plugins/daemon/index.js";
import { CODE_REVIEW_GRAPH_VERSION } from "../../../src/plugins/pins.js";

const runExecutable = promisify(execFile);
const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface FakeServiceManagerState {
  activeUnitNames: Set<string>;
  unitContentsByName: Map<string, string>;
  offeredAttempts: AutostartAttempt[][];
  unregistered: UnregisterAutostartInput[];
  lingerOn: boolean;
  usedAttemptLabel?: string;
  onRegister?: () => void;
  unreadableUnitNames?: Set<string>;
}

function createServiceState(
  overrides: Partial<FakeServiceManagerState> = {},
): FakeServiceManagerState {
  return {
    activeUnitNames: new Set(),
    unitContentsByName: new Map(),
    offeredAttempts: [],
    unregistered: [],
    lingerOn: false,
    ...overrides,
  };
}

function createFakeServiceManager(
  state: FakeServiceManagerState,
): ServiceManager {
  return {
    async isActive(unitName) {
      return { active: state.activeUnitNames.has(unitName) };
    },
    async registerAutostart(input) {
      state.onRegister?.();
      state.offeredAttempts.push(input.attempts);
      const used =
        input.attempts.find(
          (attempt) => attempt.label === state.usedAttemptLabel,
        ) ?? input.attempts[0];
      state.activeUnitNames.add(input.unitName);
      state.unitContentsByName.set(input.unitName, used.unitContents);
      const lingerEnabledByAgemon = !state.lingerOn;
      state.lingerOn = true;
      return {
        unitPath: `/fake/systemd/user/${input.unitName}`,
        lingerEnabledByAgemon,
        attemptLabel: used.label,
        failedAttempts: input.attempts
          .slice(0, input.attempts.indexOf(used))
          .map((attempt) => `${attempt.label}: did not start in this test`),
      };
    },
    async unregisterAutostart(input) {
      state.unregistered.push(input);
      state.activeUnitNames.delete(input.unitName);
      state.unitContentsByName.delete(input.unitName);
      if (!input.disableLinger) {
        return { lingerKeptFor: null };
      }
      const lingerKeptFor = [...state.unitContentsByName.keys()][0] ?? null;
      if (lingerKeptFor === null) {
        state.lingerOn = false;
      }
      return { lingerKeptFor };
    },
    async readUnitWorkingDirectory(unitName) {
      if (state.unreadableUnitNames?.has(unitName)) {
        throw new NotARegularFileError("read", unitName);
      }
      const unitContents = state.unitContentsByName.get(unitName);
      return unitContents === undefined
        ? null
        : workingDirectoryOfUnit(unitContents);
    },
  };
}

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  createdTempDirectories.push(directory);
  return directory;
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
}

interface CrgEnvironment {
  home: string;
  crgPath: string;
}

async function stubCrgEnvironment(
  binDirectoryName = "bin",
): Promise<CrgEnvironment> {
  const root = await createTempDirectory("agemon-daemon-env-");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const binDirectory = join(root, binDirectoryName);
  const crgPath = join(binDirectory, "code-review-graph");
  await writeExecutable(crgPath);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", binDirectory);
  vi.stubEnv("PIPX_HOME", join(root, "pipx"));
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("AGEMON_FAKE_SUBPROCESS", "");
  vi.stubEnv("AGEMON_DAEMON_HARDENING", undefined);
  return { home, crgPath };
}

interface RecordedCall {
  command: string;
  args: string[];
}

function createRun(calls: RecordedCall[]) {
  return async (command: string, args: string[]): Promise<SubprocessResult> => {
    calls.push({ command, args });
    if (command.endsWith("/code-review-graph") && args[0] === "--version") {
      return {
        code: 0,
        stdout: `code-review-graph ${CODE_REVIEW_GRAPH_VERSION}\n`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
  };
}

interface TestContext {
  ctx: Context;
  calls: RecordedCall[];
  infos: string[];
}

async function createTestContext(options: {
  cwd: string;
  serviceManager: ServiceManager;
}): Promise<TestContext> {
  const calls: RecordedCall[] = [];
  const infos: string[] = [];
  const ctx: Context = {
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
    ui: {
      start() {},
      succeed() {},
      fail() {},
      info(message: string) {
        infos.push(message);
      },
    },
    run: createRun(calls),
    manifest: await StateManifest.load(options.cwd),
    serviceManager: options.serviceManager,
    verifiedBinaryInstaller: { install: async () => {} },
  };
  return { ctx, calls, infos };
}

async function createSandboxDirectory(name: string): Promise<string> {
  const sandboxDirectory = await createTempDirectory("agemon-daemon-test-");
  const repoDirectory = join(sandboxDirectory, name);
  await mkdir(repoDirectory);
  return repoDirectory;
}

async function installAndReadUnit(
  repoName = "loyl",
): Promise<{ unit: string; repo: string; environment: CrgEnvironment }> {
  const environment = await stubCrgEnvironment();
  const repo = await createSandboxDirectory(repoName);
  const state = createServiceState();
  const { ctx } = await createTestContext({
    cwd: repo,
    serviceManager: createFakeServiceManager(state),
  });
  await daemonPlugin.install(ctx);
  return {
    unit: [...state.unitContentsByName.values()][0],
    repo,
    environment,
  };
}

function unitLines(unit: string, key: string): string[] {
  return unit.split("\n").filter((line) => line.startsWith(`${key}=`));
}

const UNIT_NAME_FOR = (slug: string) =>
  new RegExp(`^agemon-crg-daemon-${slug}-[0-9a-f]{8}\\.service$`);

function unitNameFor(repoRealpath: string, slug: string): string {
  const hash = createHash("sha256")
    .update(repoRealpath)
    .digest("hex")
    .slice(0, 8);
  return `agemon-crg-daemon-${slug}-${hash}.service`;
}

describe("daemon plugin unit naming", () => {
  it("unit name ignores git and uses the realpath of the repo root", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("My Cool Repo!!");
    const link = join(repo, "..", "linked");
    await symlink(repo, link);
    const state = createServiceState();
    const { ctx, calls } = await createTestContext({
      cwd: link,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    expect([...state.activeUnitNames]).toEqual([
      unitNameFor(repo, "my-cool-repo"),
    ]);
    expect(calls.map((call) => call.command)).not.toContain("git");
  });

  it("two repos with the same basename get different unit names", async () => {
    await stubCrgEnvironment();
    const state = createServiceState();
    const serviceManager = createFakeServiceManager(state);

    const repoA = await createTestContext({
      cwd: await createSandboxDirectory("app"),
      serviceManager,
    });
    const repoB = await createTestContext({
      cwd: await createSandboxDirectory("app"),
      serviceManager,
    });

    await daemonPlugin.install(repoA.ctx);
    await daemonPlugin.install(repoB.ctx);

    const unitNames = [...state.activeUnitNames];
    expect(unitNames).toHaveLength(2);
    for (const unitName of unitNames) {
      expect(unitName).toMatch(UNIT_NAME_FOR("app"));
    }
    expect(await daemonPlugin.verify(repoA.ctx)).toEqual({
      ok: true,
      detail: `${unitNames[0]} active`,
    });
  });

  it("reports the repo-scoped unit name and flags an inactive unit as unhealthy", async () => {
    const cwd = await createSandboxDirectory("loyl");
    const { ctx } = await createTestContext({
      cwd,
      serviceManager: createFakeServiceManager(createServiceState()),
    });

    const result = await daemonPlugin.verify(ctx);

    expect(result).toEqual({
      ok: false,
      detail: `${unitNameFor(cwd, "loyl")} is not active`,
    });
  });
});

describe("daemon plugin unit contents", () => {
  it("ExecStart uses the located crg binary without spawning which", async () => {
    const environment = await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx, calls } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    const unit = state.unitContentsByName.get(unitNameFor(repo, "loyl"));
    expect(unitLines(unit ?? "", "ExecStart")).toEqual([
      `ExecStart="${environment.crgPath}" "watch"`,
    ]);
    expect(calls.map((call) => call.command)).not.toContain("which");
  });

  it("fails install with a clear error when code-review-graph can't be located", async () => {
    await stubCrgEnvironment();
    vi.stubEnv("PATH", "");
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    const installError = (await daemonPlugin
      .install(ctx)
      .catch((error: unknown) => error)) as Error;

    expect(installError.message).toMatch(
      /Unable to resolve an absolute path for 'code-review-graph'/,
    );
    expect(installError.message).toContain(
      `pipx install code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`,
    );
    expect(state.offeredAttempts).toEqual([]);
  });

  it("a broken pipx venv points at uninstall and a fresh agemon run", async () => {
    await stubCrgEnvironment();
    vi.stubEnv("PATH", "");
    const pipxHome = await createTempDirectory("agemon-daemon-pipx-");
    vi.stubEnv("PIPX_HOME", pipxHome);
    const venv = join(pipxHome, "venvs", "code-review-graph");
    await writeExecutable(join(venv, "bin", "code-review-graph"));
    await writeFile(
      join(venv, "pipx_metadata.json"),
      JSON.stringify({
        main_package: {
          package: "code-review-graph",
          package_version: CODE_REVIEW_GRAPH_VERSION,
          app_paths: [{ __Path__: join(venv, "bin", "code-review-graph") }],
        },
      }),
      "utf8",
    );
    const repo = await createSandboxDirectory("loyl");
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(createServiceState()),
    });

    await expect(daemonPlugin.install(ctx)).rejects.toThrow(
      "code-review-graph's pipx venv is broken — run 'pipx uninstall code-review-graph', then 'agemon'",
    );
  });

  it("refuses a crg binary path that systemd can't execute", async () => {
    const environment = await stubCrgEnvironment("it's-bin");
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await expect(daemonPlugin.install(ctx)).rejects.toThrow(
      `code-review-graph is installed at ${environment.crgPath}, which systemd can't run; reinstall it under a path without \\ " or '`,
    );
    expect(state.offeredAttempts).toEqual([]);
  });

  it("strict unit has ReadWritePaths for the repo and crg home, matching CRG_HOME, and makes .git read-only", async () => {
    const { unit, repo, environment } = await installAndReadUnit();
    const crgHome = join(environment.home, ".code-review-graph");

    expect(unitLines(unit, "ReadWritePaths")).toEqual([
      `ReadWritePaths="${repo}" "-${crgHome}"`,
    ]);
    expect(unitLines(unit, "ReadOnlyPaths")).toEqual([
      `ReadOnlyPaths="-${repo}/.git"`,
    ]);
    expect(unitLines(unit, "Environment")).toContain(
      `Environment="CRG_HOME=${crgHome}"`,
    );
  });

  it("unit carries the git-safety Environment lines", async () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "3");
    const { unit } = await installAndReadUnit();

    expect(unitLines(unit, "Environment")).toEqual(
      expect.arrayContaining([
        'Environment="GIT_CONFIG_COUNT=2"',
        'Environment="GIT_CONFIG_KEY_0=core.fsmonitor"',
        'Environment="GIT_CONFIG_VALUE_0=false"',
        'Environment="GIT_CONFIG_KEY_1=core.hooksPath"',
        'Environment="GIT_CONFIG_VALUE_1=/dev/null"',
      ]),
    );
    expect(unitLines(unit, "UnsetEnvironment")).toEqual([
      "UnsetEnvironment=CRG_DATA_DIR GIT_CONFIG_PARAMETERS",
    ]);
  });

  it("path with %, $, quotes, backslashes and spaces produces a valid unit", async () => {
    const environment = await stubCrgEnvironment("bin $x %y");
    const repo = await createSandboxDirectory('repo a\\b"c %d');
    await mkdir(join(repo, ".git"));
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    const [[unitName, unit]] = [...state.unitContentsByName];
    const escapedRepo = repo.replaceAll("%", "%%");
    const quotedRepo = escapedRepo
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    expect(unitLines(unit, "WorkingDirectory")).toEqual([
      `WorkingDirectory=${escapedRepo}`,
    ]);
    expect(unitLines(unit, "ExecStart")).toEqual([
      `ExecStart="${environment.crgPath.replaceAll("%", "%%")}" "watch"`,
    ]);
    expect(unitLines(unit, "ReadWritePaths")[0]).toMatch(
      `ReadWritePaths="${quotedRepo}" `,
    );

    if (process.env.XDG_RUNTIME_DIR) {
      const unitDirectory = await createTempDirectory("agemon-unit-verify-");
      await writeFile(join(unitDirectory, unitName), unit, "utf8");
      const verification = await runExecutable(
        "systemd-analyze",
        ["--user", "verify", join(unitDirectory, unitName)],
        { cwd: unitDirectory },
      ).catch((error: { code?: unknown; stderr?: string }) =>
        error.code === "ENOENT"
          ? { stderr: "" }
          : Promise.reject(new Error(error.stderr)),
      );
      expect(verification.stderr).toBe("");
    }
  });

  it.each([
    ["a newline", "repo\nExecStartPre=evil"],
    ["trailing whitespace", "repo "],
    ["a trailing backslash", "repo\\"],
  ])(
    "repo path with %s is rejected before anything is written",
    async (_case, name) => {
      await stubCrgEnvironment();
      const repo = await createSandboxDirectory(name);
      const state = createServiceState();
      const { ctx } = await createTestContext({
        cwd: repo,
        serviceManager: createFakeServiceManager(state),
      });

      await expect(daemonPlugin.install(ctx)).rejects.toThrow(
        /Can't register the daemon: the repository path [\s\S]* must be an absolute path without control characters, surrounding spaces or a trailing backslash/,
      );
      expect(state.offeredAttempts).toEqual([]);
    },
  );
});

describe("daemon plugin hardening", () => {
  it("offers strict first, then compat, and records the profile used", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx, infos } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    expect(state.offeredAttempts[0].map((attempt) => attempt.label)).toEqual([
      "strict",
      "compat",
    ]);
    expect(infos).toContain("daemon hardening: strict");
    expect(
      ctx.manifest
        .getActions()
        .filter((action) => action.type === "hardening-profile")
        .map((action) => action.target),
    ).toEqual(["strict"]);
  });

  it("says why compat was used when the strict unit did not start", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState({ usedAttemptLabel: "compat" });
    const { ctx, infos } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    expect(infos).toContain(
      "daemon hardening: compat (the strict unit did not start (strict: did not start in this test); if crg's registry stores this repo's graph outside the repository, strict can't write it)",
    );
    expect(
      ctx.manifest
        .getActions()
        .find((action) => action.type === "hardening-profile")?.target,
    ).toBe("compat");
  });

  it("repo at $HOME gets compat and says why", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("home-repo");
    vi.stubEnv("HOME", repo);
    const state = createServiceState();
    const { ctx, infos } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    expect(state.offeredAttempts[0].map((attempt) => attempt.label)).toEqual([
      "compat",
    ]);
    expect(infos).toContain(
      "daemon hardening: compat (the repository is or contains your home directory)",
    );
    const unit = [...state.unitContentsByName.values()][0];
    expect(unit).not.toContain("ProtectHome");
  });

  it("AGEMON_DAEMON_HARDENING=compat offers only the compat unit", async () => {
    await stubCrgEnvironment();
    vi.stubEnv("AGEMON_DAEMON_HARDENING", "compat");
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);

    expect(state.offeredAttempts[0].map((attempt) => attempt.label)).toEqual([
      "compat",
    ]);
  });

  it("re-register keeps one registered-service and one hardening-profile entry", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.install(ctx);
    state.activeUnitNames.clear();
    state.usedAttemptLabel = "compat";
    await daemonPlugin.install(ctx);

    expect(
      ctx.manifest.getActions().map((action) => [action.type, action.target]),
    ).toEqual([
      ["enabled-linger", expect.any(String)],
      ["registered-service", `/fake/systemd/user/${unitNameFor(repo, "loyl")}`],
      ["hardening-profile", "compat"],
    ]);
    expect(
      ctx.manifest
        .getActions()
        .find((action) => action.type === "registered-service")?.resourceId,
    ).toBe(`service-unit:${unitNameFor(repo, "loyl")}`);
  });

  it("a failed ledger write after register unregisters the new unit and restores linger", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });
    const recordAction = ctx.manifest.recordAction.bind(ctx.manifest);
    vi.spyOn(ctx.manifest, "recordAction").mockImplementation(async (input) => {
      if (input.type === "hardening-profile") {
        throw new Error("disk full");
      }
      return recordAction(input);
    });

    await expect(daemonPlugin.install(ctx)).rejects.toThrow("disk full");

    expect(state.unregistered).toEqual([
      { unitName: unitNameFor(repo, "loyl"), disableLinger: true },
    ]);
    expect(state.activeUnitNames.size).toBe(0);
    expect(state.lingerOn).toBe(false);
    expect(ctx.manifest.getActions()).toEqual([]);
  });

  it("a save that fails after the entry was added leaves no daemon entries behind", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState();
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });
    const manifest = ctx.manifest as unknown as {
      persist(): Promise<void>;
    };
    const persist = manifest.persist.bind(manifest);
    let saves = 0;
    vi.spyOn(manifest, "persist").mockImplementation(async () => {
      saves += 1;
      if (saves === 2) {
        throw new Error("EIO");
      }
      return persist();
    });

    await expect(daemonPlugin.install(ctx)).rejects.toThrow("EIO");

    expect(ctx.manifest.getActions()).toEqual([]);
    expect(state.lingerOn).toBe(false);
  });

  it("re-register prunes an old registered-service entry that has no resourceId", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState({ lingerOn: true });
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });
    await ctx.manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: `/home/old/.config/systemd/user/${unitNameFor(repo, "loyl")}`,
      preExisting: false,
    });

    await daemonPlugin.install(ctx);

    expect(
      ctx.manifest
        .getActions()
        .filter((action) => action.type === "registered-service")
        .map((action) => action.resourceId),
    ).toEqual([`service-unit:${unitNameFor(repo, "loyl")}`]);
  });

  it("interrupt during daemon register rolls back unit and linger", async () => {
    await stubCrgEnvironment();
    const repo = await createSandboxDirectory("loyl");
    const state = createServiceState({
      onRegister: () => {
        process.emit("SIGINT", "SIGINT");
      },
    });
    const { ctx } = await createTestContext({
      cwd: repo,
      serviceManager: createFakeServiceManager(state),
    });
    const operations = (await daemonPlugin.plan?.(ctx)) ?? [];

    const failure = await applyPlan(ctx, [daemonPlugin], {
      plan: {
        id: "0123456789abcdef",
        agemonVersion: "9.9.9",
        desiredStateHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
        operations,
      },
      approved: operations,
      workspaceIsolationApproved: null,
      isolationStatus: "ignored",
      allowUnignoredState: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplyRollbackError);
    expect(state.unregistered).toEqual([
      { unitName: unitNameFor(repo, "loyl"), disableLinger: true },
    ]);
    expect(state.lingerOn).toBe(false);
    expect(ctx.manifest.getActions()).toEqual([]);
  });
});

describe("daemon plugin detection", () => {
  it("daemon detect writes nothing to the ledger", async () => {
    const repoDirectory = await createSandboxDirectory("adopted");
    const serviceState = createServiceState({
      activeUnitNames: new Set([unitNameFor(repoDirectory, "adopted")]),
    });
    const { ctx } = await createTestContext({
      cwd: repoDirectory,
      serviceManager: createFakeServiceManager(serviceState),
    });

    const presence = await daemonPlugin.detect(ctx);

    expect(presence).toEqual({ present: true, preExisting: true });
    expect(ctx.manifest.getActions()).toEqual([]);
  });
});

const OLD_SCHEME_UNIT = "agemon-crg-daemon-loyl.service";

function seedUnit(
  state: FakeServiceManagerState,
  unitName: string,
  workingDirectory: string,
): void {
  state.activeUnitNames.add(unitName);
  state.unitContentsByName.set(
    unitName,
    `[Service]\nWorkingDirectory=${workingDirectory}\n`,
  );
}

async function recordUnit(
  ctx: Context,
  unitName: string,
  ledger: "v3" | "pre-v3" = "v3",
): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "daemon",
    type: "registered-service",
    target: `/home/u/.config/systemd/user/${unitName}`,
    preExisting: false,
    ...(ledger === "v3" ? { resourceId: `service-unit:${unitName}` } : {}),
  });
}

async function recordLingerEnabled(ctx: Context): Promise<void> {
  await ctx.manifest.recordAction({
    plugin: "daemon",
    type: "enabled-linger",
    target: "tester",
    preExisting: false,
  });
}

async function createMigrationContext(repoName = "loyl") {
  await stubCrgEnvironment();
  const repo = await createSandboxDirectory(repoName);
  const state = createServiceState({ lingerOn: true });
  const testContext = await createTestContext({
    cwd: repo,
    serviceManager: createFakeServiceManager(state),
  });
  return { ...testContext, repo, state };
}

function registeredUnitNames(ctx: Context): string[] {
  return ctx.manifest
    .getActions()
    .filter((action) => action.type === "registered-service")
    .map((action) => action.resourceId ?? action.target);
}

describe("daemon plugin ledger-driven revert", () => {
  it("revert after a repo rename uses the recorded unit", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    await daemonPlugin.install(ctx);
    const recordedName = unitNameFor(repo, "loyl");
    const renamed = join(repo, "..", "renamed");
    await rename(repo, renamed);
    const renamedContext = await createTestContext({
      cwd: renamed,
      serviceManager: createFakeServiceManager(state),
    });

    await daemonPlugin.uninstall(renamedContext.ctx);

    expect(state.unregistered.map((call) => call.unitName)).toEqual([
      recordedName,
    ]);
  });

  it("revert skips a recorded unit name that fails validation", async () => {
    const { ctx, state, infos } = await createMigrationContext();
    await ctx.manifest.recordAction({
      plugin: "daemon",
      type: "registered-service",
      target: "/home/u/.config/systemd/user/default.target",
      preExisting: false,
    });

    await daemonPlugin.uninstall(ctx);

    expect(state.unregistered).toEqual([]);
    expect(infos).toContain(
      "ignoring ledger entry for default.target: daemon does not manage that unit",
    );
  });

  it("revert keeps a unit whose WorkingDirectory is another existing repo", async () => {
    const { ctx, repo, state, infos } = await createMigrationContext();
    const otherRepo = await createSandboxDirectory("other");
    const unitName = unitNameFor(repo, "loyl");
    seedUnit(state, unitName, otherRepo);
    await recordUnit(ctx, unitName);
    await recordLingerEnabled(ctx);

    await daemonPlugin.uninstall(ctx);

    expect(state.unregistered).toEqual([]);
    expect(state.lingerOn).toBe(true);
    expect(infos).toContain(
      `Keeping user service ${unitName}: it now runs for ${otherRepo}`,
    );
  });

  it("a nested repo's unit named by a new-scheme entry is kept", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    const nestedRepo = join(repo, "nested");
    await mkdir(nestedRepo);
    const unitName = unitNameFor(repo, "loyl");
    seedUnit(state, unitName, nestedRepo);
    await recordUnit(ctx, unitName);

    await daemonPlugin.uninstall(ctx);

    expect(state.unregistered).toEqual([]);
  });

  it("a forged entry without resourceId cannot claim a nested repo's hashed unit", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    const nestedRepo = join(repo, "nested");
    await mkdir(nestedRepo);
    const nestedUnit = unitNameFor(nestedRepo, "nested");
    seedUnit(state, nestedUnit, nestedRepo);
    await recordUnit(ctx, nestedUnit, "pre-v3");

    await daemonPlugin.uninstall(ctx);

    expect(state.unregistered).toEqual([]);
  });

  it("does not disable linger when the recorded unit file never existed", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    await recordUnit(ctx, unitNameFor(repo, "loyl"));
    await recordLingerEnabled(ctx);

    await daemonPlugin.uninstall(ctx);

    expect(state.unregistered).toEqual([
      { unitName: unitNameFor(repo, "loyl"), disableLinger: false },
    ]);
    expect(state.lingerOn).toBe(true);
  });

  it.each([
    ["a non-absolute WorkingDirectory", "relative/dir", false],
    ["an unreadable unit file", "", true],
  ])(
    "revert keeps a unit with %s",
    async (owner, workingDirectory, unreadable) => {
      const { ctx, repo, state, infos } = await createMigrationContext();
      const unitName = unitNameFor(repo, "loyl");
      seedUnit(state, unitName, workingDirectory);
      if (unreadable) {
        state.unreadableUnitNames = new Set([unitName]);
      }
      await recordUnit(ctx, unitName);

      await daemonPlugin.uninstall(ctx);

      expect(state.unregistered).toEqual([]);
      expect(infos.join("\n")).toContain(
        `Keeping user service ${unitName}: it now runs for ${owner}`,
      );
    },
  );

  it("nuke keeps linger while another repo's agemon daemon is registered", async () => {
    const { ctx, state, infos } = await createMigrationContext();
    state.lingerOn = false;
    await daemonPlugin.install(ctx);
    seedUnit(state, "agemon-crg-daemon-other-0123abcd.service", "/elsewhere");

    await daemonPlugin.uninstall(ctx);

    expect(state.lingerOn).toBe(true);
    expect(infos).toContain(
      "Keeping user linger: another agemon daemon (agemon-crg-daemon-other-0123abcd.service) still needs it",
    );
  });
});

describe("daemon plugin migration from old unit names", () => {
  it("install migrates an old-scheme unit and is idempotent on re-run", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    seedUnit(state, OLD_SCHEME_UNIT, repo);
    await recordUnit(ctx, OLD_SCHEME_UNIT);
    const newName = unitNameFor(repo, "loyl");

    const operations = (await daemonPlugin.plan?.(ctx)) ?? [];
    expect(operations.map((operation) => operation.preview)).toEqual([
      {
        kind: "note",
        text: `register systemd --user unit ${newName} to keep the code graph fresh; replaces ${OLD_SCHEME_UNIT}`,
      },
    ]);
    await daemonPlugin.install(ctx);

    expect([...state.activeUnitNames]).toEqual([newName]);
    expect(state.unregistered).toEqual([
      { unitName: OLD_SCHEME_UNIT, disableLinger: false },
    ]);
    expect(registeredUnitNames(ctx)).toEqual([`service-unit:${newName}`]);
    expect(await daemonPlugin.plan?.(ctx)).toEqual([]);
    expect(await daemonPlugin.detect(ctx)).toEqual({
      present: true,
      preExisting: false,
    });
  });

  it.each([
    ["a subdirectory", "sub"],
    ["a symlink to the repo", "link"],
    ["a path containing %", "100%"],
  ])(
    "old unit whose WorkingDirectory is %s is migrated",
    async (_case, child) => {
      const { ctx, repo, state } = await createMigrationContext();
      let workingDirectory = join(repo, child);
      if (child === "link") {
        workingDirectory = join(repo, "..", "link-to-repo");
        await symlink(repo, workingDirectory);
      } else {
        await mkdir(workingDirectory);
      }
      const written =
        child === "100%"
          ? workingDirectory.replaceAll("%", "%%")
          : workingDirectory;
      seedUnit(state, OLD_SCHEME_UNIT, written);
      await recordUnit(ctx, OLD_SCHEME_UNIT);

      await daemonPlugin.install(ctx);

      expect(state.unregistered.map((call) => call.unitName)).toEqual([
        OLD_SCHEME_UNIT,
      ]);
    },
  );

  it("migration leaves an old unit owned by another live repo in place", async () => {
    const { ctx, repo, state, infos } = await createMigrationContext();
    const otherRepo = await createSandboxDirectory("loyl");
    seedUnit(state, OLD_SCHEME_UNIT, otherRepo);
    await recordUnit(ctx, OLD_SCHEME_UNIT);

    await daemonPlugin.install(ctx);

    expect(state.activeUnitNames.has(OLD_SCHEME_UNIT)).toBe(true);
    expect(state.unregistered).toEqual([]);
    expect(registeredUnitNames(ctx)).toEqual([
      `service-unit:${unitNameFor(repo, "loyl")}`,
    ]);
    expect(infos).toContain(
      `Keeping user service ${OLD_SCHEME_UNIT}: it now runs for ${otherRepo}`,
    );
  });

  it("install completes a migration left half-done (new active, stale entry present)", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    await daemonPlugin.install(ctx);
    seedUnit(state, OLD_SCHEME_UNIT, repo);
    await recordUnit(ctx, OLD_SCHEME_UNIT);

    expect(await daemonPlugin.detect(ctx)).toEqual({
      present: false,
      preExisting: false,
    });
    await daemonPlugin.install(ctx);

    expect(state.offeredAttempts).toHaveLength(1);
    expect(state.unregistered.map((call) => call.unitName)).toEqual([
      OLD_SCHEME_UNIT,
    ]);
    expect(registeredUnitNames(ctx)).toEqual([
      `service-unit:${unitNameFor(repo, "loyl")}`,
    ]);
  });

  it("describeState shows a stale recorded unit as present-managed with the migrate hint", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    seedUnit(state, OLD_SCHEME_UNIT, repo);
    await recordUnit(ctx, OLD_SCHEME_UNIT);

    expect(await daemonPlugin.describeState?.(ctx)).toEqual([
      expect.objectContaining({
        state: "present-managed",
        detail: "registered under an old name — run 'agemon' to migrate",
      }),
    ]);
  });
});

describe("daemon plugin graph directory guard", () => {
  it("refuses to register when .code-review-graph is a symlink", async () => {
    const { ctx, repo, state } = await createMigrationContext();
    const outside = await createTempDirectory("agemon-daemon-outside-");
    await symlink(outside, join(repo, ".code-review-graph"));

    await expect(daemonPlugin.install(ctx)).rejects.toThrow(
      "Can't register the daemon: .code-review-graph in the repository is not a real directory",
    );
    expect(state.offeredAttempts).toEqual([]);
  });
});
