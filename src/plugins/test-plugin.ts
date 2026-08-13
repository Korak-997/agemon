import type { AgemonPlugin } from "./types.js";

export const testPlugin: AgemonPlugin = {
  id: "test-plugin",
  async detect(ctx) {
    return {
      present: ctx.manifest.hasActionForPlugin("test-plugin"),
      preExisting: false,
    };
  },
  async install(ctx) {
    if (ctx.dryRun) {
      return;
    }
    await ctx.manifest.recordAction({
      plugin: "test-plugin",
      type: "simulated-install",
      target: "phase-1 orchestrator checkpoint",
      preExisting: false,
    });
  },
  async verify(ctx) {
    if (ctx.dryRun) {
      return { ok: true, detail: "dry-run" };
    }
    return {
      ok: ctx.manifest.hasActionForPlugin("test-plugin"),
      detail: "action logged in manifest",
    };
  },
  async uninstall(ctx) {
    if (ctx.dryRun) {
      return;
    }
    await ctx.manifest.removeActionsForPlugin("test-plugin");
  },
};
