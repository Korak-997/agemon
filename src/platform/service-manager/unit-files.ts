export const AGEMON_DAEMON_UNIT_PATTERN =
  /^agemon-crg-daemon-[a-z0-9-]{1,60}\.service$/;
const LEGACY_AGEMON_DAEMON_UNIT_NAME = "agemon-crg-daemon.service";

export function isAgemonDaemonUnitFile(fileName: string): boolean {
  return (
    fileName === LEGACY_AGEMON_DAEMON_UNIT_NAME ||
    AGEMON_DAEMON_UNIT_PATTERN.test(fileName)
  );
}

export function workingDirectoryOfUnit(unitContents: string): string | null {
  const values = unitContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WorkingDirectory="))
    .map((line) => line.slice("WorkingDirectory=".length).trim());
  return values.at(-1) || null;
}
