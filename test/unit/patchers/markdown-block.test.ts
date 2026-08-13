import { describe, expect, it } from "vitest";
import {
  removeManagedMarkdownBlock,
  upsertManagedMarkdownBlock,
} from "../../../src/patchers/markdown-block.js";

describe("markdown-block patcher", () => {
  it("adds one managed block without touching human content", () => {
    const original = [
      "# Project Rules",
      "",
      "Keep this section exactly as-written by humans.",
      "",
      "## Notes",
      "Do not edit this line.",
      "",
    ].join("\n");

    const result = upsertManagedMarkdownBlock(
      original,
      "master-prompt",
      "Canonical rule pointer",
    );

    expect(result.changed).toBe(true);
    expect(result.nextContent).toContain("<!-- agemon:start:master-prompt -->");
    expect(result.nextContent).toContain("Canonical rule pointer");
    expect(result.nextContent).toContain("<!-- agemon:end:master-prompt -->");
    expect(result.nextContent).toContain(
      "Keep this section exactly as-written by humans.",
    );
  });

  it("is idempotent on second upsert", () => {
    const initial = upsertManagedMarkdownBlock(
      "# Header\n",
      "crg-daemon",
      "Managed block body",
    );
    const second = upsertManagedMarkdownBlock(
      initial.nextContent,
      "crg-daemon",
      "Managed block body",
    );

    expect(second.changed).toBe(false);
    expect(second.nextContent).toBe(initial.nextContent);
  });

  it("removes only the managed block", () => {
    const withBlock = upsertManagedMarkdownBlock(
      "# Header\n\nHuman content\n",
      "cleanup",
      "Temporary managed content",
    );

    const removed = removeManagedMarkdownBlock(
      withBlock.nextContent,
      "cleanup",
    );

    expect(removed.changed).toBe(true);
    expect(removed.nextContent).toContain("Human content");
    expect(removed.nextContent).not.toContain("Temporary managed content");
    expect(removed.nextContent).not.toContain("agemon:start:cleanup");
  });
});
