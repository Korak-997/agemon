import { createInterface } from "node:readline/promises";

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
export type ConflictReply = "keep-mine" | "show-theirs" | "skip";

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
