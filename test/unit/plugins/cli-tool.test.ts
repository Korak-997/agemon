import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import {
  createFakeVerifiedBinaryInstaller,
  resetFakeSubprocessState,
} from "../../../src/core/fake-subprocess.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { resolveAgemonStateDirectory } from "../../../src/core/state-root.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type {
  InstalledPackageInspection,
  VerifiedBinaryInstallRequest,
} from "../../../src/core/verified-binary-installer.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { CLI_TOOL_BUNDLE } from "../../../src/plugins/cli-tool/catalog.js";
import {
  cliToolPlugin,
  resolveVerifiedArchiveCandidates,
} from "../../../src/plugins/cli-tool/index.js";
import {
  AGNIX_NPM_TARBALL,
  AGNIX_RELEASE_ARCHIVE_SHA256,
  AGNIX_VERSION,
} from "../../../src/plugins/pins.js";

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
      return {
        unitPath: "",
        attemptLabel: "strict",
        failedAttempts: [],
      };
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

const installRequests: VerifiedBinaryInstallRequest[] = [];
const fakeInstaller = createFakeVerifiedBinaryInstaller();

const UNPINNED_AGNIX: InstalledPackageInspection = {
  kind: "installed",
  version: "0.41.0",
  differences: ["bin/agnix-binary is not a pinned build"],
};

function inspectAs(context: Context, inspection: InstalledPackageInspection) {
  context.verifiedBinaryInstaller = {
    ...context.verifiedBinaryInstaller,
    inspect: async () => inspection,
  };
}

async function writeMachineLedger(resources: object): Promise<void> {
  const { writeFile: write } = await import("node:fs/promises");
  await write(
    join((await resolveAgemonStateDirectory("prepare")).path, "machine.json"),
    JSON.stringify({ version: 1, resources }),
    { mode: 0o600 },
  );
}

async function recordAgemonInstall(context: Context): Promise<void> {
  await context.manifest.recordAction({
    plugin: "cli-tool",
    type: "installed-cli-tool",
    target: "agnix",
    preExisting: false,
  });
}

afterEach(async () => {
  installRequests.splice(0);
  resetFakeSubprocessState();
  await rm(join(process.env.XDG_STATE_HOME ?? "", "agemon", "machine.json"), {
    force: true,
  });
});

async function createTestContext(
  preinstalledPackages?: string,
): Promise<Context> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-cli-tool-test-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  process.env.AGEMON_DEV = "1";
  process.env.AGEMON_FAKE_SUBPROCESS = "1";
  if (preinstalledPackages) {
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES = preinstalledPackages;
  } else {
    delete process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES;
  }

  return {
    cwd: sandboxDirectory,
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
    ui: createNoOpUi(),
    run: runSubprocess,
    manifest: await StateManifest.load(sandboxDirectory),
    serviceManager: createNoOpServiceManager(),
    verifiedBinaryInstaller: {
      async install(request) {
        installRequests.push(request);
        await fakeInstaller.install(request);
      },
      inspect: (request) => fakeInstaller.inspect(request),
    },
  };
}

function recordCommands(context: Context): string[][] {
  const commands: string[][] = [];
  const run = context.run;
  context.run = async (command, args, options) => {
    commands.push([command, ...args]);
    return run(command, args, options);
  };
  return commands;
}

const AGNIX = CLI_TOOL_BUNDLE.find((entry) => entry.id === "agnix");
if (!AGNIX) {
  throw new Error("agnix is missing from the CLI tool bundle");
}
const AGNIX_RELEASE_URL = `https://github.com/agent-sh/agnix/releases/download/v${AGNIX_VERSION}`;

describe("cli-tool plugin", () => {
  it("installs, verifies, and uninstalls managed CLI tools", async () => {
    const context = await createTestContext();

    const detectedBeforeInstall = await cliToolPlugin.detect(context);
    expect(detectedBeforeInstall.present).toBe(false);

    await cliToolPlugin.install(context);

    const verificationAfterInstall = await cliToolPlugin.verify(context);
    expect(verificationAfterInstall.ok).toBe(true);

    const actionsAfterInstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterInstall).toHaveLength(1);
    expect(actionsAfterInstall[0]?.preExisting).toBe(false);
    expect(actionsAfterInstall[0]?.target).toBe("agnix");

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    const verificationAfterUninstall = await cliToolPlugin.verify(context);
    expect(verificationAfterUninstall.ok).toBe(false);

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
  });

  it("installs agnix only through the verified installer, from the sha512-pinned tarball", async () => {
    const context = await createTestContext();
    const commands = recordCommands(context);

    await cliToolPlugin.install(context);

    expect(
      commands.some(
        (command) => command[0] === "npm" && command[1] === "install",
      ),
    ).toBe(false);
    expect(installRequests).toEqual([
      {
        packageName: "agnix",
        version: AGNIX_VERSION,
        binaryPathInPackage: "bin/agnix-binary",
        archiveMemberName: "agnix",
        candidates: resolveVerifiedArchiveCandidates(
          AGNIX,
          `${process.platform}-${process.arch}`,
        ),
        packageTarball: AGNIX_NPM_TARBALL,
      },
    ]);
  });

  it("flags an agemon-installed agnix that is not the pinned build in verify, without running it", async () => {
    const context = await createTestContext("agnix");
    await recordAgemonInstall(context);
    inspectAs(context, UNPINNED_AGNIX);
    const commands = recordCommands(context);

    const verification = await cliToolPlugin.verify(context);

    expect(verification.ok).toBe(true);
    expect(verification.attention).toContain(
      "agnix is not the pinned agnix 0.58.0 build (bin/agnix-binary is not a pinned build); reinstall it: npm uninstall --global agnix, then run agemon",
    );
    expect(commands.some((command) => command[0] === "agnix")).toBe(false);
  });

  it("counts a migrated shared-tools record as agemon-installed", async () => {
    const context = await createTestContext("agnix");
    await writeMachineLedger({
      "npm-global:agnix": {
        origin: "migrated",
        claimedBy: context.cwd,
        ownerDirectoryId: "1:2:3",
        holders: [context.cwd],
      },
    });
    inspectAs(context, UNPINNED_AGNIX);

    expect((await cliToolPlugin.verify(context)).attention).toBeDefined();
  });

  it("only notes an adopted agnix that is not the pinned build", async () => {
    const context = await createTestContext("agnix");
    await writeMachineLedger({
      "npm-global:agnix": { origin: "pre-existing", holders: [context.cwd] },
    });
    inspectAs(context, UNPINNED_AGNIX);

    expect((await cliToolPlugin.verify(context)).attention).toBeUndefined();
    const [row] = (await cliToolPlugin.describeState?.(context)) ?? [];
    expect(row?.state).toBe("present-adopted");
    expect(row?.detail).toBe(
      "pre-existing install (agnix 0.41.0, not the pinned 0.58.0 build)",
    );
  });

  it("says when agemon could not inspect an agnix", async () => {
    const context = await createTestContext("agnix");
    inspectAs(context, {
      kind: "installed",
      version: null,
      differences: ["could not locate the global npm root (npm broke)"],
    });

    const [row] = (await cliToolPlugin.describeState?.(context)) ?? [];

    expect(row?.detail).toBe(
      "pre-existing install (agnix; agemon could not inspect it (could not locate the global npm root (npm broke)))",
    );
  });

  it("reinstalls a flagged agemon-installed agnix the user removed, and then verifies it", async () => {
    const context = await createTestContext();
    await recordAgemonInstall(context);

    expect((await cliToolPlugin.detect(context)).present).toBe(false);
    const operations = (await cliToolPlugin.plan?.(context)) ?? [];
    expect(operations.map((operation) => operation.action)).toEqual([
      "install-package",
    ]);
    await cliToolPlugin.apply?.(context, operations);

    const verification = await cliToolPlugin.verify(context);
    expect(verification).toMatchObject({ ok: true });
    expect(verification.attention).toBeUndefined();
    expect(installRequests).toHaveLength(1);
  });

  it("inspects an agemon-installed agnix once per run, and afresh under the lock", async () => {
    const context = await createTestContext("agnix");
    await recordAgemonInstall(context);
    let inspections = 0;
    context.verifiedBinaryInstaller = {
      ...context.verifiedBinaryInstaller,
      inspect: async () => {
        inspections += 1;
        return { kind: "installed", version: AGNIX_VERSION, differences: [] };
      },
    };

    await cliToolPlugin.detect(context);
    await cliToolPlugin.plan?.(context);
    await cliToolPlugin.verify(context);
    expect(inspections).toBe(1);

    const operations = (await cliToolPlugin.plan?.(context)) ?? [];
    await cliToolPlugin.apply?.(context, operations);
    expect(inspections).toBeGreaterThan(1);
  });

  it("uninstalls the package and records nothing when the verified binary install fails", async () => {
    const context = await createTestContext();
    const commands = recordCommands(context);
    context.verifiedBinaryInstaller = {
      async install() {
        throw new Error("Downloaded archive does not match its pinned sha256");
      },
      inspect: async () => ({ kind: "absent" }),
    };

    await expect(cliToolPlugin.install(context)).rejects.toThrow(
      "Downloaded archive does not match its pinned sha256 agemon uninstalled the global npm package agnix again",
    );

    expect(commands).toContainEqual(["npm", "uninstall", "--global", "agnix"]);
    expect(context.manifest.getActions()).toEqual([]);
    expect((await cliToolPlugin.verify(context)).ok).toBe(false);
  });

  it("names the manual cleanup when removing a partly installed package fails", async () => {
    const context = await createTestContext();
    const run = context.run;
    context.run = async (command, args, options) =>
      args[0] === "uninstall"
        ? { code: 1, stdout: "", stderr: "EACCES" }
        : run(command, args, options);
    context.verifiedBinaryInstaller = {
      async install() {
        throw new Error("No pinned agnix 0.58.0 build runs on this host.");
      },
      inspect: async () => ({ kind: "absent" }),
    };

    await expect(cliToolPlugin.install(context)).rejects.toThrow(
      "No pinned agnix 0.58.0 build runs on this host. Removing the partly installed agnix also failed (EACCES); run: npm uninstall --global agnix",
    );
    expect(context.manifest.getActions()).toEqual([]);
  });

  it("downloads nothing for a pre-existing agnix", async () => {
    const context = await createTestContext("agnix");

    await cliToolPlugin.install(context);

    expect(installRequests).toEqual([]);
  });

  it("previews the pinned, script-free npm install", async () => {
    const context = await createTestContext();

    const [operation] = (await cliToolPlugin.plan?.(context)) ?? [];

    expect(operation?.preview).toEqual({
      kind: "note",
      text: `npm install --global --ignore-scripts of the sha512-pinned agnix@${AGNIX_VERSION} tarball; binary from the v${AGNIX_VERSION} GitHub release, sha256-pinned`,
    });
  });

  it("maps linux-x64 to the gnu archive, then the musl fallback", () => {
    expect(resolveVerifiedArchiveCandidates(AGNIX, "linux-x64")).toEqual([
      {
        url: `${AGNIX_RELEASE_URL}/agnix-x86_64-unknown-linux-gnu.tar.gz`,
        sha256:
          AGNIX_RELEASE_ARCHIVE_SHA256["agnix-x86_64-unknown-linux-gnu.tar.gz"],
      },
      {
        url: `${AGNIX_RELEASE_URL}/agnix-x86_64-unknown-linux-musl.tar.gz`,
        sha256:
          AGNIX_RELEASE_ARCHIVE_SHA256[
            "agnix-x86_64-unknown-linux-musl.tar.gz"
          ],
      },
    ]);
  });

  it("maps linux-arm64 to the aarch64 gnu archive", () => {
    expect(resolveVerifiedArchiveCandidates(AGNIX, "linux-arm64")).toEqual([
      {
        url: `${AGNIX_RELEASE_URL}/agnix-aarch64-unknown-linux-gnu.tar.gz`,
        sha256:
          AGNIX_RELEASE_ARCHIVE_SHA256[
            "agnix-aarch64-unknown-linux-gnu.tar.gz"
          ],
      },
    ]);
  });

  it("refuses a platform without a pinned build", () => {
    expect(() =>
      resolveVerifiedArchiveCandidates(AGNIX, "darwin-arm64"),
    ).toThrow("agnix has no pinned build for darwin-arm64");
  });

  it("leaves the ledger to the orchestrator when uninstalled directly", async () => {
    const context = await createTestContext();
    await cliToolPlugin.install(context);
    const ledgerBefore = context.manifest.getActions();

    await cliToolPlugin.uninstall(context);

    expect(context.manifest.getActions()).toEqual(ledgerBefore);
  });

  it("detect writes nothing; using a pre-existing tool records a holder that nuke drops without uninstalling", async () => {
    const context = await createTestContext("agnix");
    const commands = recordCommands(context);

    const detected = await cliToolPlugin.detect(context);
    expect(detected).toEqual({ present: true, preExisting: true });
    expect(context.manifest.getActions()).toEqual([]);

    const operations = (await cliToolPlugin.plan?.(context)) ?? [];
    expect(operations.map((operation) => operation.action)).toEqual([
      "use-shared",
    ]);
    await cliToolPlugin.apply?.(context, operations);
    expect(
      context.manifest
        .getActions()
        .map((action) => [action.type, action.resourceId]),
    ).toEqual([["uses-shared-resource", "shared:npm-global:agnix"]]);
    expect(await cliToolPlugin.plan?.(context)).toEqual([]);

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    expect(
      context.manifest
        .getActions()
        .filter((action) => action.plugin === "cli-tool"),
    ).toEqual([]);
    expect(commands.some((command) => command[1] === "uninstall")).toBe(false);
  });

  it("an existing global npm agnix off PATH is refused, not overwritten or uninstalled", async () => {
    const context = await createTestContext();
    const commands = recordCommands(context);
    const stateRoot = process.env.XDG_STATE_HOME ?? "";
    await mkdir(join(stateRoot, "agemon-fake", "npm-root", "agnix"), {
      recursive: true,
    });
    const operations = (await cliToolPlugin.plan?.(context)) ?? [];

    await expect(cliToolPlugin.apply?.(context, operations)).rejects.toThrow(
      /A global npm agnix already exists at .*npm uninstall --global agnix/,
    );
    expect(
      commands.filter(
        (command) =>
          command[0] === "npm" &&
          (command[1] === "install" || command[1] === "uninstall"),
      ),
    ).toEqual([]);
    expect(context.manifest.getActions()).toEqual([]);
    await rm(join(stateRoot, "agemon-fake", "npm-root", "agnix"), {
      recursive: true,
    });
  });

  it.each<[string, { code: number; stdout: string }]>([
    ["a failing npm", { code: 1, stdout: "" }],
    ["a relative path", { code: 0, stdout: "rel/path\n" }],
    ["an unnormalised path", { code: 0, stdout: "/a/../b\n" }],
    ["two lines", { code: 0, stdout: "/a\n/b\n" }],
    ["a zero-width character", { code: 0, stdout: "/a\u200b/b\n" }],
  ])(
    "refuses to install when npm root --global returns %s",
    async (_label, reply) => {
      const context = await createTestContext();
      const commands: string[][] = [];
      const run = context.run;
      context.run = async (command, args, options) => {
        commands.push([command, ...args]);
        if (command === "npm" && args[0] === "root") {
          return { ...reply, stderr: "" };
        }
        return run(command, args, options);
      };
      const operations = (await cliToolPlugin.plan?.(context)) ?? [];

      await expect(cliToolPlugin.apply?.(context, operations)).rejects.toThrow(
        /npm root --global (failed|returned)/,
      );
      expect(
        commands.some(
          (command) => command[0] === "npm" && command[1] === "install",
        ),
      ).toBe(false);
    },
  );

  it("installs when npm's global package directory does not exist yet (custom prefix)", async () => {
    const context = await createTestContext();
    const commands: string[][] = [];
    const run = context.run;
    const missingRoot = join(
      process.env.XDG_STATE_HOME ?? "",
      "custom-prefix",
      "lib",
      "node_modules",
    );
    context.run = async (command, args, options) => {
      commands.push([command, ...args]);
      if (command === "npm" && args[0] === "root") {
        return { code: 0, stdout: `${missingRoot}\n`, stderr: "" };
      }
      return run(command, args, options);
    };
    const operations = (await cliToolPlugin.plan?.(context)) ?? [];

    await cliToolPlugin.apply?.(context, operations);

    expect(installRequests).toHaveLength(1);
    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});
  });

  it("a dangling npm link at <npm root>/agnix also counts as an existing agnix", async () => {
    const context = await createTestContext();
    const stateRoot = process.env.XDG_STATE_HOME ?? "";
    const npmRoot = join(stateRoot, "agemon-fake", "npm-root");
    await mkdir(npmRoot, { recursive: true });
    await rm(join(npmRoot, "agnix"), { recursive: true, force: true });
    await symlink(join(npmRoot, "nowhere"), join(npmRoot, "agnix"));
    const operations = (await cliToolPlugin.plan?.(context)) ?? [];

    await expect(cliToolPlugin.apply?.(context, operations)).rejects.toThrow(
      /A global npm agnix already exists/,
    );
    await rm(join(npmRoot, "agnix"));
  });

  it("an agnix the shared-tools ledger records but that is off PATH gets the PATH hint, not the uninstall advice", async () => {
    const context = await createTestContext();
    const stateRoot = process.env.XDG_STATE_HOME ?? "";
    await mkdir(join(stateRoot, "agemon-fake", "npm-root", "agnix"), {
      recursive: true,
    });
    await mkdir(join(stateRoot, "agemon"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateRoot, "agemon", "machine.json"),
      JSON.stringify({
        version: 1,
        resources: {
          "npm-global:agnix": { origin: "pre-existing", holders: [] },
        },
      }),
    );
    const operations = (await cliToolPlugin.plan?.(context)) ?? [];

    await expect(cliToolPlugin.apply?.(context, operations)).rejects.toThrow(
      "agnix is installed but 'agnix --version' fails on your PATH (it is recorded in the shared-tools ledger)",
    );
    await rm(join(stateRoot, "agemon", "machine.json"));
    await rm(join(stateRoot, "agemon-fake", "npm-root", "agnix"), {
      recursive: true,
    });
  });

  it("an old preexisting-cli-tool entry is dropped on nuke without uninstalling", async () => {
    const context = await createTestContext("agnix");
    const commands = recordCommands(context);
    const messages: string[] = [];
    context.ui = { ...context.ui, info: (message) => messages.push(message) };
    await context.manifest.recordAction({
      plugin: "cli-tool",
      type: "preexisting-cli-tool",
      target: "agnix",
      preExisting: true,
    });

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    expect(context.manifest.getActions()).toEqual([]);
    expect(commands.some((command) => command[1] === "uninstall")).toBe(false);
    expect(messages).toContain(
      "Keeping agnix: this repository is not registered as using it",
    );
  });

  it("never uninstalls a package whose ledger target is not a bundle tool", async () => {
    const context = await createTestContext();
    const commands: string[][] = [];
    context.run = async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const messages: string[] = [];
    context.ui = { ...context.ui, info: (message) => messages.push(message) };
    await context.manifest.recordAction({
      plugin: "cli-tool",
      type: "installed-cli-tool",
      target: "typescript",
      preExisting: false,
    });

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    expect(commands).toEqual([]);
    expect(messages).toContain(
      "ignoring ledger entry for typescript: cli-tool does not manage that package",
    );
    expect(context.manifest.getActions()).toEqual([]);
  });
});
