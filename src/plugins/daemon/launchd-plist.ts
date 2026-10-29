import { escapePlistString } from "../../platform/service-manager/launch-agent-files.js";
import { crgUnitEnvironment } from "../crg/environment.js";

const SYSTEM_ONLY_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface LaunchAgentPaths {
  repoRoot: string;
  crgBinaryPath: string;
}

function stringElement(value: string): string {
  return `<string>${escapePlistString(value)}</string>`;
}

function keyElement(key: string): string {
  return `<key>${escapePlistString(key)}</key>`;
}

function launchAgentEnvironment(): Record<string, string> {
  const environment = crgUnitEnvironment();
  return {
    PATH: SYSTEM_ONLY_PATH,
    ...environment.set,
    ...Object.fromEntries(environment.unset.map((name) => [name, ""])),
  };
}

export function buildLaunchAgentPlist(
  label: string,
  paths: LaunchAgentPaths,
): string {
  const environmentEntries = Object.entries(launchAgentEnvironment()).flatMap(
    ([name, value]) => [
      `    ${keyElement(name)}`,
      `    ${stringElement(value)}`,
    ],
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  ${keyElement("Label")}`,
    `  ${stringElement(label)}`,
    `  ${keyElement("ProgramArguments")}`,
    "  <array>",
    `    ${stringElement(paths.crgBinaryPath)}`,
    `    ${stringElement("watch")}`,
    "  </array>",
    `  ${keyElement("WorkingDirectory")}`,
    `  ${stringElement(paths.repoRoot)}`,
    `  ${keyElement("EnvironmentVariables")}`,
    "  <dict>",
    ...environmentEntries,
    "  </dict>",
    `  ${keyElement("RunAtLoad")}`,
    "  <true/>",
    `  ${keyElement("KeepAlive")}`,
    "  <true/>",
    `  ${keyElement("ProcessType")}`,
    `  ${stringElement("Background")}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
