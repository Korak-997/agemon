import { describe, expect, it } from "vitest";
import {
  renderUnifiedDiff,
  styleUnifiedDiff,
} from "../../../src/core/text-diff.js";

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join(
    "\n",
  );
}

describe("renderUnifiedDiff on large inputs", () => {
  it("diffs a block appended to a 5,000-line file quickly, showing only the addition", () => {
    const before = `${numberedLines("line", 5000)}\n`;
    const appendedBlock =
      "<!-- agemon:start:x -->\nrules\n<!-- agemon:end:x -->";
    const after = `${before}${appendedBlock}\n`;

    const startedAt = performance.now();
    const diff = renderUnifiedDiff(before, after, "AGENTS.md");
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(200);
    const changedLines = diff
      .split("\n")
      .slice(2)
      .filter((line) => !line.startsWith(" "));
    expect(changedLines).toEqual(
      appendedBlock.split("\n").map((line) => `+${line}`),
    );
  });

  it("keeps a common prefix and suffix as context around a middle change", () => {
    const diff = renderUnifiedDiff("a\nb\nc\nd\n", "a\nb\nX\nd\n", "f.md");

    expect(diff).toBe("--- f.md\n+++ f.md\n a\n b\n-c\n+X\n d");
  });

  it("summarises a change too large to diff line by line", () => {
    const before = numberedLines("old", 2000);
    const after = numberedLines("new", 2000);

    const diff = renderUnifiedDiff(before, after, "big.md");

    expect(diff).toBe(
      "--- big.md\n+++ big.md\n  ⋯ too large to diff line by line: 2000 lines replaced by 2000 lines",
    );
  });

  it("keeps the too-large summary visible when unchanged runs are collapsed", () => {
    const common = numberedLines("same", 50);
    const before = `${common}\n${numberedLines("old", 2000)}\n${common}`;
    const after = `${common}\n${numberedLines("new", 2000)}\n${common}`;

    const styled = styleUnifiedDiff(renderUnifiedDiff(before, after, "big.md"));

    expect(styled).toContain(
      "⋯ too large to diff line by line: 2000 lines replaced by 2000 lines",
    );
  });
});
