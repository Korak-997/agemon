export const AGEMON_DAEMON_UNIT_PATTERN =
  /^agemon-crg-daemon-[a-z0-9-]{1,60}\.service$/;
const LEGACY_AGEMON_DAEMON_UNIT_NAME = "agemon-crg-daemon.service";

export function isAgemonDaemonUnitFile(fileName: string): boolean {
  return (
    fileName === LEGACY_AGEMON_DAEMON_UNIT_NAME ||
    AGEMON_DAEMON_UNIT_PATTERN.test(fileName)
  );
}

const ENVIRONMENT_DIRECTIVE = "Environment=";
const QUOTED_UNIT_ESCAPE = /\\(["\\])/g;
const ENVIRONMENT_WORD = /"((?:[^"\\]|\\.)*)"|(\S+)/g;

export function environmentOfUnit(
  unitContents: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of unitContents.split("\n").map((entry) => entry.trim())) {
    if (!line.startsWith(ENVIRONMENT_DIRECTIVE)) {
      continue;
    }
    for (const word of line
      .slice(ENVIRONMENT_DIRECTIVE.length)
      .matchAll(ENVIRONMENT_WORD)) {
      const assignment = (
        word[1] === undefined
          ? word[2]
          : word[1].replace(QUOTED_UNIT_ESCAPE, "$1")
      ).replaceAll("%%", "%");
      const separator = assignment.indexOf("=");
      if (separator > 0) {
        environment[assignment.slice(0, separator)] = assignment.slice(
          separator + 1,
        );
      }
    }
  }
  return environment;
}

export function workingDirectoryOfUnit(unitContents: string): string | null {
  const values = unitContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WorkingDirectory="))
    .map((line) => line.slice("WorkingDirectory=".length).trim());
  return values.at(-1) || null;
}
