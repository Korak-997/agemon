import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { resetFakeSubprocessState } from "../../../src/core/fake-subprocess.js";
import { uninstallPlugins } from "../../../src/core/orchestrator.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import { runSubprocess } from "../../../src/core/subprocess-runner.js";
import type { VerifiedBinaryInstallRequest } from "../../../src/core/verified-binary-installer.js";
import type { ServiceManager } from "../../../src/platform/service-manager/index.js";
import { CLI_TOOL_BUNDLE } from "../../../src/plugins/cli-tool/catalog.js";
import {
  cliToolPlugin,
  resolveVerifiedArchiveCandidates,
} from "../../../src/plugins/cli-tool/index.js";
import {
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
        lingerEnabledByAgemon: false,
      };
    },
    async unregisterAutostart() {
      return;
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

afterEach(() => {
  installRequests.splice(0);
  resetFakeSubprocessState();
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
    os: "ubuntu",
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
      },
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

  it("installs the pinned npm package without scripts, then its verified binary", async () => {
    const context = await createTestContext();
    const commands = recordCommands(context);

    await cliToolPlugin.install(context);

    expect(commands).toContainEqual([
      "npm",
      "install",
      "--global",
      "--ignore-scripts",
      `agnix@${AGNIX_VERSION}`,
    ]);
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
      },
    ]);
  });

  it("uninstalls the package and records nothing when the verified binary install fails", async () => {
    const context = await createTestContext();
    const commands = recordCommands(context);
    context.verifiedBinaryInstaller = {
      async install() {
        throw new Error("Downloaded archive does not match its pinned sha256");
      },
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
      text: `npm install --global --ignore-scripts agnix@${AGNIX_VERSION}; binary from the v${AGNIX_VERSION} GitHub release, sha256-pinned`,
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

  it("records pre-existing CLI tools without managing uninstall", async () => {
    const context = await createTestContext("agnix");

    const detected = await cliToolPlugin.detect(context);
    expect(detected.present).toBe(true);
    expect(detected.preExisting).toBe(true);

    const actionsAfterDetect = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterDetect).toHaveLength(1);
    expect(actionsAfterDetect[0]?.preExisting).toBe(true);

    await uninstallPlugins({ ...context, yes: true }, [cliToolPlugin], {});

    const actionsAfterUninstall = context.manifest
      .getActions()
      .filter((action) => action.plugin === "cli-tool");
    expect(actionsAfterUninstall).toEqual([]);
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
