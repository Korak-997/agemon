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

export interface CreateConfirmerInput {
  yes: boolean;
}

/**
 * Builds the single confirmation policy shared by anything that needs to ask
 * "are you sure" mid-run: `--yes` always proceeds without asking, a
 * non-interactive session always declines (there is no one to ask), and an
 * interactive session gets a real y/N prompt.
 */
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
