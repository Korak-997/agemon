import type { Context } from "../core/context.js";
import type { AgemonPlugin, CapabilityStateRow } from "../plugins/types.js";

export async function collectCapabilityStates(
  ctx: Context,
  plugins: AgemonPlugin[],
): Promise<CapabilityStateRow[]> {
  const rows: CapabilityStateRow[] = [];
  for (const plugin of plugins) {
    if (!plugin.describeState) {
      continue;
    }
    rows.push(...(await plugin.describeState(ctx)));
  }

  return rows.sort(
    (a, b) =>
      a.capabilityId.localeCompare(b.capabilityId) ||
      a.resourceId.localeCompare(b.resourceId),
  );
}
