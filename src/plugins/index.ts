import { cliToolPlugin } from "./cli-tool/index.js";
import { crgPlugin } from "./crg/index.js";
import { daemonPlugin } from "./daemon/index.js";
import { masterPromptPlugin } from "./master-prompt/index.js";
import { skillsPlugin } from "./skills/index.js";
import { testPlugin } from "./test-plugin.js";
import type { AgemonPlugin } from "./types.js";

const capabilityRegistry: AgemonPlugin[] = [
  crgPlugin,
  daemonPlugin,
  skillsPlugin,
  cliToolPlugin,
  masterPromptPlugin,
];

export const CORE_CAPABILITY_IDS: string[] = capabilityRegistry.map(
  (plugin) => plugin.id,
);

export function getRegisteredPlugins(): AgemonPlugin[] {
  const devOnlyPlugins: AgemonPlugin[] =
    process.env.AGEMON_DEV === "1" ? [testPlugin] : [];
  return [...capabilityRegistry, ...devOnlyPlugins];
}
