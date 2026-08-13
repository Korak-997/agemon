import { crgPlugin } from "./crg/index.js";
import { daemonPlugin } from "./daemon/index.js";
import { testPlugin } from "./test-plugin.js";
import type { AgemonPlugin } from "./types.js";

const corePluginOrder: AgemonPlugin[] = [crgPlugin, daemonPlugin];

export function getRegisteredPlugins(): AgemonPlugin[] {
  const devOnlyPlugins: AgemonPlugin[] =
    process.env.AGEMON_DEV === "1" ? [testPlugin] : [];
  return [...corePluginOrder, ...devOnlyPlugins];
}
