export const AGEMON_DAEMON_UNIT_PATTERN =
  /^agemon-crg-daemon-[a-z0-9-]{1,60}\.service$/;

export function workingDirectoryOfUnit(unitContents: string): string | null {
  const values = unitContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WorkingDirectory="))
    .map((line) => line.slice("WorkingDirectory=".length).trim());
  return values.at(-1) || null;
}
