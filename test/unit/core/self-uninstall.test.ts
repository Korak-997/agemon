import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { protectedInstallDirectories } from "../../../src/core/install-location.js";
import type { InstallMethod } from "../../../src/core/install-method.js";
import {
  resolveAgemonStateDirectory,
  resolveStateRoot,
  withRepositoryRunLock,
} from "../../../src/core/state-root.js";

const prompt = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn(() => true),
  promptYesNo: vi.fn(async () => true),
}));
vi.mock("../../../src/core/prompt.js", () => prompt);

const { runSelfUninstall } = await import(
  "../../../src/core/self-uninstall.js"
);

const SHARED_TOOLS = [
  {
    id: "pipx:code-review-graph" as const,
    toolName: "code-review-graph",
    manualRemoveCommand: "pipx uninstall code-review-graph",
  },
];

const createdTempDirectories: string[] = [];
let root: string;
let home: string;
let installDir: string;
let cacheDirectory: string;

async function createInstallTree(directory: string, version = "4.8.0") {
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "agemon", version }),
  );
  await writeFile(join(directory, "bin", "agemon.js"), "// agemon\n");
  await writeFile(join(directory, ".agemon-install"), `${version}\n`);
}

async function linkIntoHomeBin(target: string): Promise<string> {
  const linkPath = join(home, ".local", "bin", "agemon");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await symlink(target, linkPath);
  return linkPath;
}

async function machineStateDirectory(): Promise<string> {
  return (await resolveAgemonStateDirectory("prepare")).path;
}

async function writeMachineLedger(resources: object): Promise<void> {
  await writeFile(
    join(await machineStateDirectory(), "machine.json"),
    JSON.stringify({ version: 1, resources }),
    { mode: 0o600 },
  );
}

async function createRepositoryWithState(): Promise<string> {
  const repository = join(root, "repo");
  await mkdir(join(repository, ".agemon"), { recursive: true });
  await writeFile(join(repository, ".agemon", "state.json"), "{}");
  return repository;
}

function uninstall(
  options: { yes?: boolean; dryRun?: boolean; method?: InstallMethod } = {},
) {
  return runSelfUninstall({
    method: options.method ?? { kind: "install-script", installDir },
    yes: options.yes ?? true,
    dryRun: options.dryRun ?? false,
    sharedTools: SHARED_TOOLS,
  });
}

function printed(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call.join(" "))
    .join("\n");
}

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-self-uninstall-test-")),
  );
  createdTempDirectories.push(root);
  home = join(root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  cacheDirectory = join(root, "cache", "agemon");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(cacheDirectory, "update-check.json"), "{}");
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  installDir = join(root, "opt", "agemon");
  await createInstallTree(installDir);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await rm(join(resolveStateRoot(), "agemon"), {
    recursive: true,
    force: true,
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  prompt.isInteractiveTerminal.mockReturnValue(true);
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("runSelfUninstall for an install-script copy", () => {
  it("removes the install, its rollback copy, its link, the cache and unused machine state", async () => {
    await createInstallTree(`${installDir}.prev`, "4.7.2");
    const linkPath = await linkIntoHomeBin(
      join(installDir, "bin", "agemon.js"),
    );
    const stateDirectory = await machineStateDirectory();
    await mkdir(join(stateDirectory, "tools", "0123"), { recursive: true });

    await expect(uninstall()).resolves.toBe(0);

    for (const path of [
      installDir,
      `${installDir}.prev`,
      linkPath,
      cacheDirectory,
      stateDirectory,
    ]) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("keeps a link that points somewhere else", async () => {
    const elsewhere = join(root, "other-agemon.js");
    await writeFile(elsewhere, "");
    const linkPath = await linkIntoHomeBin(elsewhere);

    await uninstall();

    expect(existsSync(linkPath)).toBe(true);
  });

  it("keeps a .prev the installer did not create", async () => {
    await mkdir(`${installDir}.prev`);
    await writeFile(join(`${installDir}.prev`, "notes.txt"), "mine");

    await uninstall();

    expect(existsSync(join(`${installDir}.prev`, "notes.txt"))).toBe(true);
    expect(printed()).toContain("not created by the agemon installer");
  });

  it("refuses an install dir without .agemon-install and removes nothing", async () => {
    await rm(join(installDir, ".agemon-install"));

    await expect(uninstall()).rejects.toThrow(/no .agemon-install marker/);
    expect(existsSync(installDir)).toBe(true);
    expect(existsSync(cacheDirectory)).toBe(true);
  });

  it.each([
    ["a missing package.json", () => rm(join(installDir, "package.json"))],
    [
      "a symlinked install dir",
      async () => {
        const real = join(root, "real-agemon");
        const { rename } = await import("node:fs/promises");
        await rename(installDir, real);
        await symlink(real, installDir);
      },
    ],
  ])("refuses %s and removes nothing", async (_label, arrange) => {
    await arrange();

    await expect(uninstall()).rejects.toThrow(/no .agemon-install marker/);
    expect(existsSync(cacheDirectory)).toBe(true);
  });

  it("refuses the home directory even when it carries the marker", async () => {
    await createInstallTree(home);

    await expect(
      uninstall({ method: { kind: "install-script", installDir: home } }),
    ).rejects.toThrow(/system or home directory/);
    expect(existsSync(join(home, ".agemon-install"))).toBe(true);
  });

  it("removes nothing when the install belongs to another user", async () => {
    const uid = process.geteuid?.() ?? 0;
    vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);

    await expect(uninstall()).rejects.toThrow(/Nothing was removed/);
    expect(existsSync(installDir)).toBe(true);
    expect(existsSync(cacheDirectory)).toBe(true);
  });

  it("keeps machine state while a repository still uses a shared tool, and lists that repository", async () => {
    const repository = await createRepositoryWithState();
    await writeMachineLedger({
      "pipx:code-review-graph": {
        origin: "pre-existing",
        holders: [repository],
      },
    });

    await expect(uninstall()).resolves.toBe(0);

    expect(
      existsSync(join(await machineStateDirectory(), "machine.json")),
    ).toBe(true);
    expect(existsSync(installDir)).toBe(false);
    expect(printed()).toContain("code-review-graph is still used by");
    expect(printed()).toContain(`  ${repository}`);
    expect(printed()).toContain("run 'agemon nuke' in each first");
  });

  it("removes machine state whose only holder is gone, and prints the tool's manual uninstall", async () => {
    const stateDirectory = await machineStateDirectory();
    await writeMachineLedger({
      "pipx:code-review-graph": {
        origin: "installed",
        installedBy: join(root, "deleted-repo"),
        ownerDirectoryId: "1:2:3",
        holders: [join(root, "deleted-repo")],
      },
    });

    await expect(uninstall()).resolves.toBe(0);

    expect(existsSync(stateDirectory)).toBe(false);
    expect(printed()).toContain("pipx uninstall code-review-graph");
  });

  it("removes nothing while an interrupted apply can still be recovered", async () => {
    const stateDirectory = await machineStateDirectory();
    await mkdir(join(stateDirectory, "journals", "abc"), { recursive: true });
    await writeFile(join(stateDirectory, "journals", "abc", "plan.json"), "{}");

    await expect(uninstall()).rejects.toThrow(/run 'agemon recover'/);

    expect(existsSync(join(stateDirectory, "journals"))).toBe(true);
    expect(existsSync(installDir)).toBe(true);
  });

  it("keeps machine state while agemon runs in another repository", async () => {
    const repository = await createRepositoryWithState();
    const stateDirectory = await machineStateDirectory();
    let releaseRunLock = () => {};
    let runLockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      runLockTaken = resolve;
    });
    const otherRun = withRepositoryRunLock(
      repository,
      () =>
        new Promise<void>((resolve) => {
          releaseRunLock = resolve;
          runLockTaken();
        }),
    );
    await taken;

    try {
      await uninstall();
    } finally {
      releaseRunLock();
      await otherRun;
    }

    expect(existsSync(stateDirectory)).toBe(true);
    expect(printed()).toContain("agemon is running in another repository");
  });

  it("keeps machine state that holds entries agemon does not create", async () => {
    const stateDirectory = await machineStateDirectory();
    await mkdir(join(stateDirectory, "my-notes"));

    await uninstall();

    expect(existsSync(join(stateDirectory, "my-notes"))).toBe(true);
    expect(printed()).toContain("which agemon does not create");
  });

  it("keeps a cache directory that holds files agemon does not create", async () => {
    await writeFile(join(cacheDirectory, "mine.txt"), "x");

    await uninstall();

    expect(existsSync(join(cacheDirectory, "mine.txt"))).toBe(true);
  });

  it("prints the manual uninstall of a migrated tool nobody uses as possibly agemon's", async () => {
    await writeMachineLedger({
      "pipx:code-review-graph": {
        origin: "migrated",
        claimedBy: join(root, "deleted-repo"),
        ownerDirectoryId: "1:2:3",
        holders: [join(root, "deleted-repo")],
      },
    });

    await uninstall();

    expect(printed()).toContain(
      "pipx uninstall code-review-graph (it may have been installed by an older agemon)",
    );
  });

  it("only previews with --dry-run, or without a terminal and --yes", async () => {
    await expect(uninstall({ dryRun: true })).resolves.toBe(0);
    expect(existsSync(installDir)).toBe(true);

    prompt.isInteractiveTerminal.mockReturnValue(false);
    await expect(uninstall({ yes: false })).resolves.toBe(0);
    expect(existsSync(installDir)).toBe(true);
    expect(printed()).toContain("Re-run with --yes");
  });

  it("leaves a cache directory others can write to", async () => {
    const { chmod } = await import("node:fs/promises");
    await chmod(cacheDirectory, 0o777);

    await uninstall();

    expect(existsSync(cacheDirectory)).toBe(true);
    expect(printed()).toContain("not a private directory owned by you");
  });
});

describe("runSelfUninstall for other install methods", () => {
  it("prints the npm uninstall command for an npm-global copy", async () => {
    await expect(
      uninstall({
        method: {
          kind: "npm-global",
          packageRoot: "/usr/lib/node_modules/agemon",
          prefix: "/usr",
        },
      }),
    ).resolves.toBe(0);
    expect(printed()).toContain(
      "npm uninstall --global --prefix '/usr' agemon",
    );
    expect(existsSync(installDir)).toBe(true);
    expect(printed()).not.toContain("Could not read");
  });

  it.each([
    [{ kind: "dev" } as InstallMethod, /source checkout/],
    [
      {
        kind: "unknown",
        packageRoot: "/x/node_modules/agemon",
      } as InstallMethod,
      /cannot tell how/,
    ],
  ])("refuses a %o copy", async (method, message) => {
    await expect(uninstall({ method })).rejects.toThrow(message);
  });
});

describe("protected install directories", () => {
  it("match the list install.sh refuses", () => {
    const script = readFileSync("install.sh", "utf8");
    const listed = /for protected_path in ([^;]+); do/
      .exec(script)?.[1]
      .replace(/\\\n/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) =>
        entry.replace(/^"|"$/g, "").replace(/^\$\{HOME\}|^\$HOME/, "/home/u"),
      );

    expect(listed).toEqual(protectedInstallDirectories("/home/u"));
  });
});
