import { describe, expect, it } from "vitest";
import { mergeYamlFrontmatter } from "../../../src/patchers/yaml-frontmatter.js";

describe("yaml-frontmatter patcher", () => {
  it("adds frontmatter when missing and keeps document body", () => {
    const content = "# Rule Body\n\nKeep this body text.\n";
    const merged = mergeYamlFrontmatter(content, {
      globs: ["**/*.ts"],
      severity: "error",
    });

    expect(merged.changed).toBe(true);
    expect(merged.nextContent.startsWith("---\n")).toBe(true);
    expect(merged.nextContent).toContain("globs:");
    expect(merged.nextContent).toContain("Keep this body text.");
  });

  it("deep-merges existing frontmatter and is idempotent", () => {
    const source = [
      "---",
      "meta:",
      "  owner: agemon",
      "  tags:",
      "    - baseline",
      "enabled: true",
      "---",
      "Body",
      "",
    ].join("\n");

    const first = mergeYamlFrontmatter(source, {
      meta: {
        tags: ["phase-5"],
      },
      enabled: true,
    });

    const second = mergeYamlFrontmatter(first.nextContent, {
      meta: {
        tags: ["phase-5"],
      },
      enabled: true,
    });

    expect(first.changed).toBe(true);
    expect(first.nextContent).toContain("owner: agemon");
    expect(first.nextContent).toContain("- phase-5");
    expect(second.changed).toBe(false);
  });
});
