import { testPlugin } from "./test-plugin.js";
import type { AgemonPlugin } from "./types.js";

const corePluginOrder: AgemonPlugin[] = [];

export function getRegisteredPlugins(): AgemonPlugin[] {
	const devOnlyPlugins: AgemonPlugin[] =
		process.env.AGEMON_DEV === "1" ? [testPlugin] : [];
	return [...corePluginOrder, ...devOnlyPlugins];
}
