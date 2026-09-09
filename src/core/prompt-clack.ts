import { cancel, isCancel, select } from "@clack/prompts";
import type { GatePrompts } from "./consent.js";
import type { ConflictReply, GateReply } from "./prompt.js";

const CANCELLED_EXIT_CODE = 130;

export function assertNotCancelled<Value>(value: Value | symbol): Value {
  if (isCancel(value)) {
    cancel("Cancelled — nothing applied.");
    process.exit(CANCELLED_EXIT_CODE);
  }
  return value as Value;
}

export const clackPrompts: GatePrompts = {
  async gate(summary): Promise<GateReply> {
    return assertNotCancelled(
      await select<GateReply>({
        message: summary,
        options: [
          { value: "approve", label: "Proceed" },
          { value: "decline", label: "Skip" },
          { value: "show-diff", label: "Show diff" },
        ],
        initialValue: "approve",
      }),
    );
  },
  async conflict(summary): Promise<ConflictReply> {
    return assertNotCancelled(
      await select<ConflictReply>({
        message: summary,
        options: [
          { value: "keep-mine", label: "Keep yours" },
          { value: "show-theirs", label: "Show agemon's" },
          { value: "skip", label: "Skip" },
        ],
        initialValue: "skip",
      }),
    );
  },
};
