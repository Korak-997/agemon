import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  containsHomeDirectory,
  resolveHomeDirectory,
} from "../platform/home.js";
import { INSTALL_MARKER_FILE_NAME } from "./install-method.js";
import { printable } from "./untrusted-text.js";

const ROOT_UID = 0;
const ROOT_INSTALL_DIRECTORY = "/usr/local/lib/agemon";
const USER_INSTALL_DIRECTORY_IN_HOME = join(".local", "share", "agemon");
const ROOT_SENSITIVE_VARIABLES = ["XDG_STATE_HOME", "XDG_CACHE_HOME"];

export function currentUid(): number {
  return process.geteuid?.() ?? process.getuid?.() ?? -1;
}

function defaultInstallDirectory(): string {
  return currentUid() === ROOT_UID
    ? ROOT_INSTALL_DIRECTORY
    : join(resolveHomeDirectory(), USER_INSTALL_DIRECTORY_IN_HOME);
}

export function protectedInstallDirectories(home: string): string[] {
  return [
    "/",
    "/bin",
    "/etc",
    "/home",
    "/opt",
    "/usr",
    "/usr/bin",
    "/usr/local",
    "/usr/local/bin",
    "/var",
    home,
    join(home, ".local"),
    join(home, ".local", "share"),
  ];
}

export async function isProtectedInstallDirectory(
  realDirectory: string,
): Promise<boolean> {
  for (const candidate of protectedInstallDirectories(resolveHomeDirectory())) {
    try {
      if ((await realpath(candidate)) === realDirectory) {
        return true;
      }
    } catch {}
  }
  return containsHomeDirectory(realDirectory);
}

export async function isDefaultInstallDirectory(
  installDir: string,
): Promise<boolean> {
  try {
    return (
      (await realpath(defaultInstallDirectory())) ===
      (await realpath(installDir))
    );
  } catch {
    return false;
  }
}

export function assertRootUsesItsOwnEnvironment(): void {
  if (currentUid() !== ROOT_UID) {
    return;
  }
  const rootHome = userInfo().homedir;
  const borrowedVariables = ROOT_SENSITIVE_VARIABLES.filter(
    (name) => process.env[name] !== undefined,
  );
  if (process.env.HOME !== rootHome || borrowedVariables.length > 0) {
    throw new Error(
      `Running as root with another user's environment (HOME=${printable(process.env.HOME ?? "")}${borrowedVariables.map((name) => `, ${name} set`).join("")}). Run it as root with root's own environment, for example plain 'sudo' or 'sudo -H', not 'sudo -E'.`,
    );
  }
}

export async function assertCurrentUserOwns(path: string): Promise<void> {
  const owner = (await stat(path)).uid;
  const uid = currentUid();
  if (owner !== uid) {
    throw new Error(
      uid === ROOT_UID
        ? `${printable(path)} belongs to uid ${owner}, not root. Run this as that user, without sudo.`
        : `${printable(path)} belongs to ${owner === ROOT_UID ? "root" : `uid ${owner}`}. Run this with sudo (as its owner).`,
    );
  }
  try {
    await access(path, constants.W_OK);
    await access(dirname(path), constants.W_OK);
  } catch {
    throw new Error(
      `${printable(path)} or its parent directory is not writable, so it cannot be replaced.`,
    );
  }
}

async function readPackageName(directory: string): Promise<unknown> {
  try {
    return (
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
      }
    ).name;
  } catch {
    return undefined;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function readInstallTreeVersion(
  directory: string,
): Promise<string | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const markerPath = join(directory, INSTALL_MARKER_FILE_NAME);
  const isAgemonTree =
    (await isRegularFile(markerPath)) &&
    (await readPackageName(directory)) === "agemon" &&
    (await isRegularFile(join(directory, "bin", "agemon.js")));
  return isAgemonTree ? (await readFile(markerPath, "utf8")).trim() : null;
}
