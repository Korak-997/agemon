import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  clean: true,
  sourcemap: true,
  // Inline all runtime dependencies so dist/index.js is a single
  // self-contained file — the .sh installer ships this bundle without
  // node_modules, so nothing here can be left as an external import.
  noExternal: ["boxen", "commander", "ora", "picocolors", "yaml"],
});
