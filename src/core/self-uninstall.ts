import { constants } from "node:fs";
import { access, lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveHomeDirectory } from "../platform/home.js";
import { theme } from "../ui/theme.js";
import { withFileLock } from "./file-lock.js";
import {
  assertCurrentUserOwns,
  assertRootUsesItsOwnEnvironment,
  currentUid,
  isProtectedInstallDirectory,
  readInstallTreeVersion,
} from "./install-location.js";
import type { InstallMethod } from "./install-method.js";
import {
  readMachineLedger,
  type SharedResourceId,
  withMachineLedgerLock,
  withoutMissingHolders,
} from "./machine-ledger.js";
import { confirmOrPreview, shellQuoted } from "./self-upgrade.js";
import { resolveAgemonStateDirectory } from "./state-root.js";
import { printable } from "./untrusted-text.js";
import { resolveAgemonCacheDirectory } from "./update-check.js";

const BIN_LINK_CANDIDATES = (home: string) => [
  join(home, ".local", "bin", "agemon"),
  "/usr/local/bin/agemon",
];
const PREVIOUS_INSTALL_SUFFIX = ".prev";
const MACHINE_LOCK_FILE_NAME = "machine.lock";
const GROUP_AND_OTHER_WRITE_BITS = 0o022;
const UPDATE_CHECK_CACHE_FILE_NAME = "update-check.json";
const ENTRIES_AGEMON_CREATES_IN_ITS_STATE =
  /^(machine\.json(\.tmp-.+)?|(machine|tools|skills-src)\.lock(\.break)?|tools|skills-src|journals|runs)$/;

export interface SharedToolRemoval {
  id: SharedResourceId;
  toolName: string;
  manualRemoveCommand: string;
}

export interface SelfUninstallRequest {
  method: InstallMethod;
  yes: boolean;
  dryRun: boolean;
  sharedTools: SharedToolRemoval[];
}

interface MachineStateUse {
  blockers: string[];
  repositoriesWithState: string[];
  unusedSharedToolCommands: string[];
}

interface RemovalPlan {
  binLinks: string[];
  previousInstall: string | null;
  machineState: string | null;
  cacheDirectory: string | null;
  installDir: string;
  kept: string[];
  problems: string[];
  machineStateUse: MachineStateUse;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readEntriesUnlessMissing(
  directory: string,
  options: { recursive: boolean },
) {
  try {
    return await readdir(directory, {
      recursive: options.recursive,
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function hasAnyFile(directory: string): Promise<boolean> {
  return (await readEntriesUnlessMissing(directory, { recursive: true })).some(
    (entry) => !entry.isDirectory(),
  );
}

async function isAnyRunLockHeld(stateDirectory: string): Promise<boolean> {
  const runsDirectory = join(stateDirectory, "runs");
  const lockNames = (
    await readEntriesUnlessMissing(runsDirectory, { recursive: false })
  )
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".lock"));
  for (const lockName of lockNames) {
    try {
      await withFileLock(join(runsDirectory, lockName), async () => {}, {
        waitMs: 0,
      });
    } catch {
      return true;
    }
  }
  return false;
}

async function unknownStateEntries(stateDirectory: string): Promise<string[]> {
  return (await readdir(stateDirectory)).filter(
    (entry) => !ENTRIES_AGEMON_CREATES_IN_ITS_STATE.test(entry),
  );
}

async function describeMachineStateUse(
  stateDirectory: string,
  sharedTools: SharedToolRemoval[],
): Promise<MachineStateUse> {
  const ledger = await readMachineLedger();
  const blockers: string[] = [];
  const repositories = new Set<string>();
  const unusedSharedToolCommands: string[] = [];
  for (const [id, record] of Object.entries(ledger.resources)) {
    const tool = sharedTools.find((candidate) => candidate.id === id) ?? {
      toolName: id,
      manualRemoveCommand: `remove ${id} yourself`,
    };
    const liveHolders = await withoutMissingHolders(record.holders, () => {});
    if (liveHolders.length > 0) {
      blockers.push(
        `${tool.toolName} is still used by ${liveHolders.map(printable).join(", ")}`,
      );
      for (const holder of liveHolders) {
        repositories.add(holder);
      }
    } else if (record.origin === "installed") {
      unusedSharedToolCommands.push(tool.manualRemoveCommand);
    } else if (record.origin === "migrated") {
      unusedSharedToolCommands.push(
        `${tool.manualRemoveCommand} (it may have been installed by an older agemon)`,
      );
    }
  }
  if (await hasAnyFile(join(stateDirectory, "journals"))) {
    blockers.push("an interrupted apply can still be recovered");
  }
  if (await isAnyRunLockHeld(stateDirectory)) {
    blockers.push("agemon is running in another repository");
  }
  const unknownEntries = await unknownStateEntries(stateDirectory);
  if (unknownEntries.length > 0) {
    blockers.push(
      `it holds ${unknownEntries.map(printable).join(", ")}, which agemon does not create`,
    );
  }
  const repositoriesWithState: string[] = [];
  for (const repository of repositories) {
    if (await pathExists(join(repository, ".agemon", "state.json"))) {
      repositoriesWithState.push(repository);
    }
  }
  return {
    blockers,
    repositoriesWithState,
    unusedSharedToolCommands,
  };
}

async function linksToInstall(
  linkPath: string,
  installDir: string,
): Promise<boolean> {
  try {
    return (
      (await lstat(linkPath)).isSymbolicLink() &&
      (await realpath(linkPath)) === join(installDir, "bin", "agemon.js")
    );
  } catch {
    return false;
  }
}

async function checkRemovable(path: string, problems: string[]): Promise<void> {
  try {
    await assertCurrentUserOwns(path);
  } catch (error) {
    problems.push((error as Error).message);
  }
}

async function isPrivateDirectoryOfThisUser(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return (
      stats.isDirectory() &&
      stats.uid === currentUid() &&
      (stats.mode & GROUP_AND_OTHER_WRITE_BITS) === 0
    );
  } catch {
    return false;
  }
}

async function planInstallScriptRemoval(
  installDir: string,
  sharedTools: SharedToolRemoval[],
): Promise<RemovalPlan> {
  if ((await readInstallTreeVersion(installDir)) === null) {
    throw new Error(
      `${printable(installDir)} has no .agemon-install marker from the install script; remove it by hand if it is agemon.`,
    );
  }
  if (await isProtectedInstallDirectory(installDir)) {
    throw new Error(
      `${printable(installDir)} is a system or home directory; refusing to remove it.`,
    );
  }
  const kept: string[] = [];
  const problems: string[] = [];
  await checkRemovable(installDir, problems);

  const binLinks: string[] = [];
  for (const linkPath of BIN_LINK_CANDIDATES(resolveHomeDirectory())) {
    if (await linksToInstall(linkPath, installDir)) {
      try {
        await access(dirname(linkPath), constants.W_OK);
        binLinks.push(linkPath);
      } catch {
        problems.push(`${linkPath} is in a directory you cannot write to.`);
      }
    }
  }

  const previousDir = `${installDir}${PREVIOUS_INSTALL_SUFFIX}`;
  let previousInstall: string | null = null;
  if ((await readInstallTreeVersion(previousDir)) !== null) {
    await checkRemovable(previousDir, problems);
    previousInstall = previousDir;
  } else if (await pathExists(previousDir)) {
    kept.push(`${printable(previousDir)}: not created by the agemon installer`);
  }

  let machineState: string | null = null;
  let machineStateUse: MachineStateUse = {
    blockers: [],
    repositoriesWithState: [],
    unusedSharedToolCommands: [],
  };
  try {
    const stateDirectory = (await resolveAgemonStateDirectory("check")).path;
    if (await pathExists(stateDirectory)) {
      if (await hasAnyFile(join(stateDirectory, "journals"))) {
        problems.push(
          "An interrupted apply can still be recovered: run 'agemon recover' in that repository before removing agemon.",
        );
      }
      machineStateUse = await describeMachineStateUse(
        stateDirectory,
        sharedTools,
      );
      if (machineStateUse.blockers.length === 0) {
        await checkRemovable(stateDirectory, problems);
        machineState = stateDirectory;
      } else {
        kept.push(
          `${printable(stateDirectory)}: ${machineStateUse.blockers.join("; ")}`,
        );
      }
    }
  } catch (error) {
    kept.push(`agemon's machine state: ${(error as Error).message}`);
  }

  const cacheDirectory = resolveAgemonCacheDirectory();
  let removableCache: string | null = null;
  if (!(await pathExists(cacheDirectory))) {
    removableCache = null;
  } else if (!(await isPrivateDirectoryOfThisUser(cacheDirectory))) {
    kept.push(
      `${printable(cacheDirectory)}: not a private directory owned by you`,
    );
  } else if (
    (await readdir(cacheDirectory)).some(
      (entry) => entry !== UPDATE_CHECK_CACHE_FILE_NAME,
    )
  ) {
    kept.push(
      `${printable(cacheDirectory)}: it holds files agemon does not create`,
    );
  } else {
    await checkRemovable(cacheDirectory, problems);
    removableCache = cacheDirectory;
  }

  return {
    binLinks,
    previousInstall,
    machineState,
    cacheDirectory: removableCache,
    installDir,
    kept,
    problems,
    machineStateUse,
  };
}

function printRepositoryNotes(use: MachineStateUse): void {
  if (use.repositoriesWithState.length > 0) {
    console.log(
      [
        "These repositories still have agemon-managed files; run 'agemon nuke' in each first.",
        "(Only repositories that use a shared tool are known to agemon.)",
        ...use.repositoriesWithState.map((path) => `  ${printable(path)}`),
      ].join("\n"),
    );
  }
  if (use.unusedSharedToolCommands.length > 0) {
    console.log(
      [
        "Shared tools no repository uses any more; remove them yourself if nothing else needs them:",
        ...use.unusedSharedToolCommands.map((command) => `  ${command}`),
      ].join("\n"),
    );
  }
}

function removalTargets(plan: RemovalPlan): string[] {
  return [
    ...plan.binLinks,
    ...(plan.previousInstall ? [plan.previousInstall] : []),
    ...(plan.machineState ? [plan.machineState] : []),
    ...(plan.cacheDirectory ? [plan.cacheDirectory] : []),
    plan.installDir,
  ];
}

function printPlan(plan: RemovalPlan): void {
  console.log(
    [
      "agemon self-uninstall removes:",
      ...removalTargets(plan).map((path) => `  ${printable(path)}`),
      ...(plan.kept.length > 0
        ? ["and keeps:", ...plan.kept.map((reason) => `  ${reason}`)]
        : []),
      "It never changes files inside repositories.",
    ].join("\n"),
  );
  printRepositoryNotes(plan.machineStateUse);
}

async function removeMachineState(
  stateDirectory: string,
  sharedTools: SharedToolRemoval[],
): Promise<string | null> {
  const blockers = await withMachineLedgerLock(async () => {
    const use = await describeMachineStateUse(stateDirectory, sharedTools);
    if (use.blockers.length > 0) {
      return use.blockers;
    }
    for (const entry of await readdir(stateDirectory)) {
      if (entry !== MACHINE_LOCK_FILE_NAME) {
        await rm(join(stateDirectory, entry), { recursive: true, force: true });
      }
    }
    return [];
  });
  if (blockers.length > 0) {
    return `${printable(stateDirectory)}: ${blockers.join("; ")}`;
  }
  try {
    await rmdir(stateDirectory);
    return null;
  } catch {
    return `${printable(stateDirectory)}: another agemon run wrote to it while it was being removed`;
  }
}

async function removeAll(
  plan: RemovalPlan,
  sharedTools: SharedToolRemoval[],
): Promise<string[]> {
  const leftBehind: string[] = [];
  const attempt = async (path: string, removal: () => Promise<unknown>) => {
    try {
      await removal();
    } catch (error) {
      leftBehind.push(`${printable(path)}: ${(error as Error).message}`);
    }
  };
  for (const linkPath of plan.binLinks) {
    await attempt(linkPath, () => rm(linkPath));
  }
  if (plan.previousInstall) {
    const previousInstall = plan.previousInstall;
    await attempt(previousInstall, () =>
      rm(previousInstall, { recursive: true, force: true }),
    );
  }
  if (plan.machineState) {
    const machineState = plan.machineState;
    await attempt(machineState, async () => {
      const keptReason = await removeMachineState(machineState, sharedTools);
      if (keptReason !== null) {
        leftBehind.push(keptReason);
      }
    });
  }
  if (plan.cacheDirectory) {
    const cacheDirectory = plan.cacheDirectory;
    await attempt(cacheDirectory, async () => {
      await rm(join(cacheDirectory, UPDATE_CHECK_CACHE_FILE_NAME), {
        force: true,
      });
      await rmdir(cacheDirectory);
    });
  }
  await attempt(plan.installDir, () =>
    rm(plan.installDir, { recursive: true, force: true }),
  );
  return leftBehind;
}

async function printNonScriptGuidance(
  request: SelfUninstallRequest & {
    method: Exclude<InstallMethod, { kind: "install-script" }>;
  },
): Promise<number> {
  const { method } = request;
  switch (method.kind) {
    case "npm-global":
      console.log(
        `agemon was installed with npm. Remove it with: npm uninstall --global --prefix ${shellQuoted(printable(method.prefix))} agemon`,
      );
      try {
        const stateDirectory = (await resolveAgemonStateDirectory("check"))
          .path;
        if (await pathExists(stateDirectory)) {
          printRepositoryNotes(
            await describeMachineStateUse(stateDirectory, request.sharedTools),
          );
        }
      } catch (error) {
        console.log(
          `(Could not read agemon's machine state to list repositories: ${(error as Error).message})`,
        );
      }
      return 0;
    case "npx":
      console.log(
        "agemon is running through npx; there is no install to remove (npx keeps it only in its cache).",
      );
      return 0;
    case "dev":
      throw new Error(
        "This is a source checkout; agemon will not delete it. Remove it yourself.",
      );
    case "unknown":
      throw new Error(
        `agemon cannot tell how ${printable(method.packageRoot)} was installed, so it will not remove it. Uninstall it the way you installed it.`,
      );
  }
}

export async function runSelfUninstall(
  request: SelfUninstallRequest,
): Promise<number> {
  const { method } = request;
  if (method.kind !== "install-script") {
    return printNonScriptGuidance({ ...request, method });
  }
  assertRootUsesItsOwnEnvironment();
  const plan = await planInstallScriptRemoval(
    method.installDir,
    request.sharedTools,
  );
  if (plan.problems.length > 0) {
    throw new Error(
      `Nothing was removed:\n${plan.problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
  }
  printPlan(plan);
  if (request.dryRun) {
    return 0;
  }
  if (!(await confirmOrPreview("Remove agemon from this machine?", request))) {
    return 0;
  }
  const leftBehind = await removeAll(plan, request.sharedTools);
  if (leftBehind.length > 0) {
    console.error(
      theme.danger(
        [
          "agemon was only partly removed. Still present:",
          ...leftBehind.map((line) => `  ${line}`),
        ].join("\n"),
      ),
    );
    return 1;
  }
  console.log(theme.ok("agemon is removed from this machine."));
  return 0;
}
