import type { Context } from "../../src/core/context.js";
import type { AgemonPlugin } from "../../src/plugins/types.js";

export async function applyAllPlanned(
  plugin: AgemonPlugin,
  ctx: Context,
): Promise<void> {
  if (plugin.plan === undefined || plugin.apply === undefined) {
    throw new Error(`${plugin.id} has no plan and apply`);
  }
  await plugin.apply(ctx, await plugin.plan(ctx));
}
