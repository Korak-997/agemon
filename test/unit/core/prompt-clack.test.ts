import { afterEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => ({
  select: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  select: clack.select,
  cancel: clack.cancel,
  isCancel: (value: unknown) => typeof value === "symbol",
}));

const { clackPrompts } = await import("../../../src/core/prompt-clack.js");

afterEach(() => {
  vi.restoreAllMocks();
  clack.select.mockReset();
  clack.cancel.mockReset();
});

describe("clackPrompts.gate", () => {
  it("returns the chosen select value unchanged", async () => {
    clack.select.mockResolvedValueOnce("show-diff");
    await expect(clackPrompts.gate("Proceed?")).resolves.toBe("show-diff");
  });

  it("offers approve/decline/show-diff with decline preselected", async () => {
    clack.select.mockResolvedValueOnce("decline");
    await clackPrompts.gate("Write instruction files?");
    expect(clack.select).toHaveBeenCalledWith({
      message: "Write instruction files?",
      initialValue: "decline",
      options: [
        { value: "approve", label: "Proceed" },
        { value: "decline", label: "Skip" },
        { value: "show-diff", label: "Show diff" },
      ],
    });
  });

  it("cancels with a message and exits 130 when the prompt is aborted", async () => {
    clack.select.mockResolvedValueOnce(Symbol("cancel"));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await clackPrompts.gate("Proceed?");

    expect(clack.cancel).toHaveBeenCalledWith("Cancelled — nothing applied.");
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe("clackPrompts.conflict", () => {
  it("returns the chosen select value unchanged", async () => {
    clack.select.mockResolvedValueOnce("keep-mine");
    await expect(clackPrompts.conflict("Which version?")).resolves.toBe(
      "keep-mine",
    );
  });

  it("defaults to skip", async () => {
    clack.select.mockResolvedValueOnce("skip");
    await clackPrompts.conflict("Which version?");
    expect(clack.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "skip" }),
    );
  });
});
