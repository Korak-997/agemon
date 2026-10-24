import { constants } from "node:os";
import { errorMessage } from "./error-message.js";

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_EXIT_CODE_BASE = 128;

type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

export type ExitProcess = (code: number) => void;

function exitCodeFor(signal: InterruptSignal): number {
  return SIGNAL_EXIT_CODE_BASE + constants.signals[signal];
}

export class ApplyInterruptedError extends Error {
  readonly signal: InterruptSignal;
  readonly exitCode: number;

  constructor(signal: InterruptSignal, stepError?: unknown) {
    super(
      stepError === undefined
        ? `interrupted by ${signal}`
        : `interrupted by ${signal} (${errorMessage(stepError)})`,
    );
    this.name = "ApplyInterruptedError";
    this.signal = signal;
    this.exitCode = exitCodeFor(signal);
  }
}

export function ignoringTerminalErrors(print: () => void): void {
  try {
    print();
  } catch {
    // After SIGHUP the terminal may be gone (EIO); rollback and its result must not depend on it.
  }
}

export interface InterruptionWatch {
  throwIfInterrupted(): void;
  causeOf(error: unknown): unknown;
  dispose(): void;
}

export function watchForInterruption(
  onFirstSignal: () => void,
  exitProcess: ExitProcess,
): InterruptionWatch {
  let received: InterruptSignal | null = null;

  const handleSignal = (signal: InterruptSignal): void => {
    if (received !== null) {
      exitProcess(exitCodeFor(signal));
      return;
    }
    received = signal;
    ignoringTerminalErrors(onFirstSignal);
  };
  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, handleSignal);
  }

  return {
    throwIfInterrupted() {
      if (received !== null) {
        throw new ApplyInterruptedError(received);
      }
    },
    causeOf(error) {
      if (received === null || error instanceof ApplyInterruptedError) {
        return error;
      }
      return new ApplyInterruptedError(received, error);
    },
    dispose() {
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, handleSignal);
      }
    },
  };
}
