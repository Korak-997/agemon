import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createStepSpinner } from "../../../src/ui/spinner.js";

beforeAll(() => {
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLines(
  run: (spinner: ReturnType<typeof createStepSpinner>) => void,
): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  run(createStepSpinner());
  return lines;
}

describe("createStepSpinner (non-interactive fallback)", () => {
  it("prefixes start with [step/total] when both are given", () => {
    const [line] = captureLines((spinner) => {
      spinner.start("Applying crg", { step: 2, total: 5 });
    });
    expect(line).toBe("[2/5] Applying crg");
  });

  it("prefixes start with an auto-incrementing counter when no options are given", () => {
    const lines = captureLines((spinner) => {
      spinner.start("first");
      spinner.succeed("first");
      spinner.start("second");
    });
    expect(lines[0]).toBe("[1] first");
    expect(lines[2]).toBe("[2] second");
  });

  it("marks success with the ok symbol, the label and an elapsed suffix", () => {
    const [, line] = captureLines((spinner) => {
      spinner.start("Applying crg", { step: 1, total: 1 });
      spinner.succeed("Applied crg");
    });
    expect(line).toMatch(/^\[ok] Applied crg \d+\.\d+s$/);
  });

  it("marks failure with the fail symbol and the label", () => {
    const [, line] = captureLines((spinner) => {
      spinner.start("Applying crg");
      spinner.fail("apply rolled back");
    });
    expect(line).toBe("[x] apply rolled back");
  });

  it("indents info while a step is active and left-aligns it otherwise", () => {
    const active = captureLines((spinner) => {
      spinner.start("Applying crg");
      spinner.info("already present");
    });
    expect(active[1]).toBe("  already present");

    const idle = captureLines((spinner) => {
      spinner.info("Binary check: pipx present");
    });
    expect(idle[0]).toBe("Binary check: pipx present");
  });
});
