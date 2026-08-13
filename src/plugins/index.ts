import { cliToolPlugin } from "./cli-tool/index.js";
import { crgPlugin } from "./crg/index.js";
import { daemonPlugin } from "./daemon/index.js";
import { masterPromptPlugin } from "./master-prompt/index.js";
import { patcherCheckpointPlugin } from "./patcher-checkpoint.js";
import { skillsPlugin } from "./skills/index.js";
import { testPlugin } from "./test-plugin.js";
import type { AgemonPlugin } from "./types.js";
import { workflowScaffolderPlugin } from "./workflow-scaffolder/index.js";

const corePluginOrder: AgemonPlugin[] = [
  crgPlugin,
  daemonPlugin,
  skillsPlugin,
  workflowScaffolderPlugin,
  cliToolPlugin,
  masterPromptPlugin,
];

export function getRegisteredPlugins(): AgemonPlugin[] {
  const devOnlyPlugins: AgemonPlugin[] =
    process.env.AGEMON_DEV === "1" ? [testPlugin, patcherCheckpointPlugin] : [];
  return [...corePluginOrder, ...devOnlyPlugins];
}
