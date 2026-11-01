import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RefusedFileError, readRegularFileIfExists } from "../../core/files.js";

export const AGEMON_LAUNCH_AGENT_PATTERN =
  /^dev\.agemon\.crg\.[a-z0-9-]{1,40}-[0-9a-f]{8}\.plist$/;
const PLIST_FILE_SUFFIX = ".plist";
const BINARY_PLIST_MAGIC = "bplist";
const XML_COMMENTS = /<!--[\s\S]*?-->/g;
const CDATA_SECTION_START = "<![CDATA[";

const XML_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
];

export function escapePlistString(value: string): string {
  return XML_ESCAPES.reduce(
    (escaped, [character, entity]) => escaped.replaceAll(character, entity),
    value,
  );
}

function unescapePlistString(value: string): string {
  return [...XML_ESCAPES]
    .reverse()
    .reduce(
      (unescaped, [character, entity]) =>
        unescaped.replaceAll(entity, character),
      value,
    );
}

export function launchAgentLabelOf(plistFileName: string): string {
  if (!AGEMON_LAUNCH_AGENT_PATTERN.test(plistFileName)) {
    throw new RefusedFileError(
      `Refusing to manage ${plistFileName}: it is not an agemon launch agent name.`,
    );
  }
  return plistFileName.slice(0, -PLIST_FILE_SUFFIX.length);
}

export function readPlistString(
  plistContents: string,
  key: "Label" | "WorkingDirectory",
  plistPath: string,
): string {
  if (
    plistContents.startsWith(BINARY_PLIST_MAGIC) ||
    plistContents.includes(CDATA_SECTION_START)
  ) {
    throw new RefusedFileError(
      `Refusing to read ${plistPath}: it is a binary plist or contains CDATA, so it is not the file agemon wrote.`,
    );
  }
  const values = [
    ...plistContents
      .replace(XML_COMMENTS, "")
      .matchAll(
        new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"),
      ),
  ].map((match) => unescapePlistString(match[1]));
  if (values.length !== 1) {
    throw new RefusedFileError(
      `Refusing to read ${plistPath}: it does not have exactly one ${key}, so it is not the file agemon wrote.`,
    );
  }
  return values[0];
}

const MAX_AGEMON_PLIST_CHARACTERS = 64 * 1024;
const ENVIRONMENT_DICT =
  /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/;
const STRING_ENTRY = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;

export function readPlistEnvironment(
  plistContents: string,
): Record<string, string> | null {
  if (
    plistContents.length > MAX_AGEMON_PLIST_CHARACTERS ||
    plistContents.startsWith(BINARY_PLIST_MAGIC) ||
    plistContents.includes(CDATA_SECTION_START)
  ) {
    return null;
  }
  const dictionary = ENVIRONMENT_DICT.exec(
    plistContents.replace(XML_COMMENTS, ""),
  )?.[1];
  if (dictionary === undefined) {
    return {};
  }
  return Object.fromEntries(
    [...dictionary.matchAll(STRING_ENTRY)].map((entry) => [
      unescapePlistString(entry[1]),
      unescapePlistString(entry[2]),
    ]),
  );
}

export interface LaunchAgentFiles {
  plistPathFor(plistFileName: string): string;
  readPlist(plistFileName: string): Promise<string | null>;
  findAgemonLaunchAgent(): Promise<string | null>;
}

export function createLaunchAgentFiles(homeDir: string): LaunchAgentFiles {
  const launchAgentsDirectory = join(homeDir, "Library", "LaunchAgents");
  const plistPathFor = (plistFileName: string) => {
    launchAgentLabelOf(plistFileName);
    return join(launchAgentsDirectory, plistFileName);
  };

  return {
    plistPathFor,
    readPlist: (plistFileName) =>
      readRegularFileIfExists(plistPathFor(plistFileName)),
    async findAgemonLaunchAgent() {
      let fileNames: string[];
      try {
        fileNames = await readdir(launchAgentsDirectory);
      } catch {
        return null;
      }
      return (
        fileNames.find((fileName) =>
          AGEMON_LAUNCH_AGENT_PATTERN.test(fileName),
        ) ?? null
      );
    },
  };
}
