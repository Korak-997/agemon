import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = "src";
const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s+|import\s*\(\s*|import\s+)["']([^"'.][^"']*)["']/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

describe("package.json runtime dependencies", () => {
  it("lists only packages that src/ imports", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const imported = new Set(
      sourceFiles(SOURCE_DIRECTORY).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER_PATTERN)].map(
          (match) => packageNameOf(match[1]),
        ),
      ),
    );

    const unused = Object.keys(manifest.dependencies ?? {}).filter(
      (name) => !imported.has(name),
    );

    expect(unused).toEqual([]);
  });
});
