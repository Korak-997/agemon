import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".sandbox/**"],
    setupFiles: ["test/setup/isolated-state-home.ts"],
    pool: "forks",
    isolate: true,
    testTimeout: 15_000,
  },
});
