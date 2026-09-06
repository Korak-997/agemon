import type { Context } from "../core/context.js";
import type { AgemonPlugin } from "./types.js";

export function resolveCurrentDesiredRevision(
  plugins: AgemonPlugin[],
  ctx: Context,
  resourceId: string,
): string | null {
  for (const plugin of plugins) {
    const revision = plugin.desiredRevision?.(ctx, resourceId) ?? null;
    if (revision !== null) {
      return revision;
    }
  }
  return null;
}
