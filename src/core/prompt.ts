import { createInterface } from "node:readline/promises";

/**
 * Whether we can actually show a prompt and read a response from a human —
 * false in CI, piped output, or any other non-TTY invocation.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export type GateReply = "approve" | "decline" | "show-diff";

export async function promptGate(message: string): Promise<GateReply> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [y/N/d] `))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") {
      return "approve";
    }
    if (answer === "d" || answer === "diff") {
      return "show-diff";
    }
    return "decline";
  } finally {
    rl.close();
  }
}

export type ConflictReply = "keep-mine" | "show-theirs" | "skip";

export async function promptConflict(message: string): Promise<ConflictReply> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [keep/show/Skip] `))
      .trim()
      .toLowerCase();
    if (answer === "keep" || answer === "k") {
      return "keep-mine";
    }
    if (answer === "show" || answer === "s") {
      return "show-theirs";
    }
    return "skip";
  } finally {
    rl.close();
  }
}

export interface CreateConfirmerInput {
  yes: boolean;
}

export function createConfirmer(
  input: CreateConfirmerInput,
): (message: string) => Promise<boolean> {
  return async (message: string): Promise<boolean> => {
    if (input.yes) {
      return true;
    }
    if (!isInteractiveTerminal()) {
      return false;
    }
    return promptYesNo(message);
  };
}
