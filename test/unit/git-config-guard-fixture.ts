import type { GitConfigGuard } from "../../src/core/untrusted-git-config.js";

export const CLEAN_GIT_CONFIG_GUARD: GitConfigGuard = {
  planned: async () => ({ kind: "clean" }),
  recheck: async () => ({ kind: "clean" }),
};
