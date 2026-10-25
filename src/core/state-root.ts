import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const TOOLS_DIRECTORY_MODE = 0o700;

export function resolveStateRoot(): string {
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
  return join(homeDirectory, ".local", "state");
}

export function resolveToolsRoot(): string {
  return join(resolveStateRoot(), "agemon", "tools");
}
