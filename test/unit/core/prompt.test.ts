import { describe, expect, it } from "vitest";
import {
  createConfirmer,
  isInteractiveTerminal,
} from "../../../src/core/prompt.js";

describe("createConfirmer", () => {
  it("proceeds without prompting when --yes is set", async () => {
    const confirm = createConfirmer({ yes: true });
    await expect(confirm("Rewrite/fix it now?")).resolves.toBe(true);
  });

  it("declines without prompting outside a TTY when --yes is not set", async () => {
    // Test runners have no attached TTY, so this exercises the real
    // non-interactive branch rather than a mocked one.
    expect(isInteractiveTerminal()).toBe(false);

    const confirm = createConfirmer({ yes: false });
    await expect(confirm("Rewrite/fix it now?")).resolves.toBe(false);
  });
});
