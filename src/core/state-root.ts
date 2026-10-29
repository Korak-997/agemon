import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type HeldFileLock, withFileLock } from "./file-lock.js";
import { sha256Hex } from "./fingerprint.js";
import { printable } from "./untrusted-text.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const GROUP_AND_OTHER_BITS = 0o077;
const GROUP_WRITE = 0o020;
const OTHER_WRITE = 0o002;
const STICKY_BIT = 0o1000;
const ROOT_UID = 0;
const REPOSITORY_STATE_KEY_LENGTH = 16;
const RUN_LOCK_WAIT_MS = 0;

export type StateDirectoryMode = "check" | "prepare";

export interface AgemonStateDirectory {
  path: string;
  tightenedFromMode: number | null;
}

export interface LocalAccounts {
  uid: number;
  username: string;
  groupFile: string;
  passwdFile: string;
}

function currentAccounts(): LocalAccounts {
  const user = userInfo();
  return {
    uid: user.uid,
    username: user.username,
    groupFile: "/etc/group",
    passwdFile: "/etc/passwd",
  };
}

export function resolveStateRoot(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && isAbsolute(xdgStateHome)) {
    return xdgStateHome;
  }
  const homeDirectory = homedir();
  if (!isAbsolute(homeDirectory)) {
    throw new Error(
      "Cannot locate agemon's state directory: set HOME (or XDG_STATE_HOME) to an absolute path.",
    );
  }
  return hostPlatform === "darwin"
    ? join(homeDirectory, "Library", "Application Support")
    : join(homeDirectory, ".local", "state");
}

async function readColonSeparatedRows(path: string): Promise<string[][]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(":"));
}

export async function isUserPrivateGroup(
  gid: number,
  accounts: LocalAccounts,
): Promise<boolean> {
  let groups: string[][];
  let users: string[][];
  try {
    groups = await readColonSeparatedRows(accounts.groupFile);
    users = await readColonSeparatedRows(accounts.passwdFile);
  } catch {
    return false;
  }
  const groupsWithGid = groups.filter((fields) => fields[2] === String(gid));
  const isPrivateGroupRow = (fields: string[]) =>
    fields[0] === accounts.username && (fields[3] ?? "").trim() === "";
  if (groupsWithGid.length === 0 || !groupsWithGid.every(isPrivateGroupRow)) {
    return false;
  }
  return !users.some(
    (fields) => fields[3] === String(gid) && fields[0] !== accounts.username,
  );
}

function refuseDirectory(directory: string, reason: string): never {
  throw new Error(
    `Refusing to use ${printable(directory)}: ${reason}. Fix it (for example 'chmod g-w,o-w ${printable(directory)}', or point XDG_STATE_HOME at a directory you own), then run agemon again. Groups served only by LDAP or NSS are not recognised as private.`,
  );
}

async function assertNotWritableByOthers(
  directory: string,
  mode: number,
  gid: number,
  accounts: LocalAccounts,
): Promise<void> {
  if (mode & OTHER_WRITE) {
    refuseDirectory(directory, "other users can write to it");
  }
  if (mode & GROUP_WRITE && !(await isUserPrivateGroup(gid, accounts))) {
    refuseDirectory(directory, "its group can write to it");
  }
}

async function assertSafeStateRoot(
  stateRoot: string,
  accounts: LocalAccounts,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(stateRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    refuseDirectory(stateRoot, "it is not a directory");
  }
  if (stats.uid !== accounts.uid && stats.uid !== ROOT_UID) {
    refuseDirectory(stateRoot, "it is owned by another user");
  }
  if (!(stats.mode & STICKY_BIT)) {
    await assertNotWritableByOthers(stateRoot, stats.mode, stats.gid, accounts);
  }
}

async function openAgemonDirectory(
  directory: string,
  mode: StateDirectoryMode,
): Promise<Awaited<ReturnType<typeof open>> | null> {
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    return await open(directory, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      refuseDirectory(directory, "it is not a real directory");
    }
    if (code !== "ENOENT") {
      throw error;
    }
  }
  if (mode === "check") {
    return null;
  }
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  return openAgemonDirectory(directory, "check");
}

export async function resolveAgemonStateDirectory(
  mode: StateDirectoryMode,
  accounts: LocalAccounts = currentAccounts(),
): Promise<AgemonStateDirectory> {
  const stateRoot = resolveStateRoot();
  const directory = join(stateRoot, "agemon");
  if (mode === "prepare") {
    await mkdir(stateRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  await assertSafeStateRoot(stateRoot, accounts);

  const handle = await openAgemonDirectory(directory, mode);
  if (handle === null) {
    return { path: directory, tightenedFromMode: null };
  }
  try {
    const stats = await handle.stat();
    if (stats.uid !== accounts.uid) {
      refuseDirectory(directory, "it is owned by another user");
    }
    await assertNotWritableByOthers(directory, stats.mode, stats.gid, accounts);
    if (mode === "check" || !(stats.mode & GROUP_AND_OTHER_BITS)) {
      return { path: directory, tightenedFromMode: null };
    }
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    return {
      path: directory,
      tightenedFromMode: stats.mode & PERMISSION_BITS,
    };
  } finally {
    await handle.close();
  }
}

export async function checkAgemonStateDirectoryBeforeRun(
  dryRun: boolean,
  report: (line: string) => void,
): Promise<void> {
  const directory = await resolveAgemonStateDirectory(
    dryRun ? "check" : "prepare",
  );
  if (directory.tightenedFromMode !== null) {
    report(
      `Restricted ${printable(directory.path)} to its owner (mode was ${directory.tightenedFromMode.toString(8)}).`,
    );
  }
}

export async function preparePrivateStateDirectory(
  name: string,
): Promise<string> {
  const directory = join(
    (await resolveAgemonStateDirectory("prepare")).path,
    name,
  );
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return directory;
}

export function prepareToolsRoot(): Promise<string> {
  return preparePrivateStateDirectory("tools");
}

export async function repositoryStateKey(repoRoot: string): Promise<string> {
  return sha256Hex(await realpath(repoRoot)).slice(
    0,
    REPOSITORY_STATE_KEY_LENGTH,
  );
}

export async function withAgemonStateLock<Result>(
  lockRelativePath: string,
  work: (lock: HeldFileLock) => Promise<Result>,
  waitMs: number,
): Promise<Result> {
  const lockPath = join(
    (await resolveAgemonStateDirectory("prepare")).path,
    lockRelativePath,
  );
  await mkdir(dirname(lockPath), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  return withFileLock(lockPath, work, { waitMs });
}

export async function withRepositoryRunLock<Result>(
  repoRoot: string,
  work: () => Promise<Result>,
): Promise<Result> {
  return withAgemonStateLock(
    join("runs", `${await repositoryStateKey(repoRoot)}.lock`),
    () => work(),
    RUN_LOCK_WAIT_MS,
  );
}
