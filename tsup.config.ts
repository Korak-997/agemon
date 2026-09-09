import { createRequire } from "node:module";
import { defineConfig } from "tsup";

const packageJson = createRequire(import.meta.url)("./package.json") as {
  dependencies?: Record<string, string>;
};

const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  clean: true,
  sourcemap: true,
  noExternal: runtimeDependencies,
});
