import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  removeManagedMarkdownBlockFile,
  upsertManagedMarkdownBlockFile,
} from "../patchers/markdown-block.js";
import type { AgemonPlugin } from "./types.js";

const PLUGIN_ID = "patcher-checkpoint";
const BLOCK_ID = "phase-5-checkpoint";
const TARGET_FILE = "CLAUDE.md";

function getTargetPath(cwd: string): string {
  return join(cwd, TARGET_FILE);
}

function hasManagedBlock(cwd: string): boolean {
  const filePath = getTargetPath(cwd);
  if (!existsSync(filePath)) {
    return false;
  }

  const content = readFileSync(filePath, "utf8");
  return content.includes(`<!-- agemon:start:${BLOCK_ID} -->`);
}

export const patcherCheckpointPlugin: AgemonPlugin = {
  id: PLUGIN_ID,
  async detect(ctx) {
    return {
      present: hasManagedBlock(ctx.cwd),
      preExisting: false,
    };
  },
  async install(ctx) {
    if (ctx.dryRun) {
      ctx.ui.info(`Would patch ${TARGET_FILE} with one managed markdown block`);
      return;
    }

    const targetPath = getTargetPath(ctx.cwd);
    const filePreviouslyExisted = existsSync(targetPath);
    const changed = await upsertManagedMarkdownBlockFile(
      targetPath,
      BLOCK_ID,
      "This block is owned by agemon and safe to remove during nuke.",
    );

    if (!changed) {
      return;
    }

    await ctx.manifest.recordAction({
      plugin: PLUGIN_ID,
      type: "patched-block",
      target: TARGET_FILE,
      preExisting: filePreviouslyExisted,
    });
  },
  async verify(ctx) {
    if (ctx.dryRun) {
      return { ok: true, detail: "dry-run" };
    }
    return {
      ok: hasManagedBlock(ctx.cwd),
      detail: `managed block present in ${TARGET_FILE}`,
    };
  },
  async uninstall(ctx) {
    if (ctx.dryRun) {
      ctx.ui.info(`Would remove managed markdown block from ${TARGET_FILE}`);
      return;
    }

    const targetPath = getTargetPath(ctx.cwd);
    await removeManagedMarkdownBlockFile(targetPath, BLOCK_ID);
    await ctx.manifest.removeActionsForPlugin(PLUGIN_ID);
  },
};
