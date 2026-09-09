import { progress } from "@clack/prompts";

export interface StepProgress {
  start(label: string, max: number): void;
  advance(label?: string): void;
  stop(label?: string): void;
}

export const SILENT_PROGRESS: StepProgress = {
  start() {},
  advance() {},
  stop() {},
};

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function createStepProgress(): StepProgress {
  if (!isInteractive()) {
    return SILENT_PROGRESS;
  }

  let bar: ReturnType<typeof progress> | undefined;
  return {
    start(label, max) {
      bar = progress({ style: "heavy", max });
      bar.start(label);
    },
    advance(label) {
      bar?.advance(1, label);
    },
    stop(label) {
      bar?.stop(label);
      bar = undefined;
    },
  };
}
