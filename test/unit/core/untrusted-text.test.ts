import { describe, expect, it } from "vitest";
import {
  isSafeIdentifier,
  printable,
} from "../../../src/core/untrusted-text.js";

describe("printable", () => {
  it("keeps newlines and tabs and replaces terminal control characters", () => {
    expect(printable("a\tb\nc")).toBe("a\tb\nc");
    expect(printable("line\r\n\u001b[2Jx\u007f\u0085")).toBe("line?\n?[2Jx??");
  });

  it("replaces bidi, zero-width and other invisible formatting characters", () => {
    expect(
      printable("a\u202eb\u2066c\u200bd\u2028e\u061cf\u2060g\ufeffh"),
    ).toBe("a?b?c?d?e?f?g?h");
  });
});

describe("isSafeIdentifier", () => {
  it("accepts ordinary identifiers and paths", () => {
    expect(isSafeIdentifier("rule-file:.github/copilot-instructions.md")).toBe(
      true,
    );
  });

  it.each(["a\nb", "a\tb", "a\rb", "a\u001bb", "a\u202eb", "a\u0000b"])(
    "refuses %j",
    (value) => {
      expect(isSafeIdentifier(value)).toBe(false);
    },
  );
});
