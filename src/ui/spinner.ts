import { spinner as clackSpinner } from "@clack/prompts";
import { symbol } from "./symbols.js";
import { theme } from "./theme.js";

export interface StepOptions {
  step?: number;
  total?: number;
}

export interface StepSpinner {
  start(label: string, options?: StepOptions): void;
  succeed(label?: string): void;
  fail(label?: string): void;
  info(label: string): void;
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function formatElapsed(startedAt: number): string {
  const seconds = (Date.now() - startedAt) / 1000;
  return `${seconds.toFixed(1)}s`;
}

export function createStepSpinner(): StepSpinner {
  let autoStep = 0;
  let active: ReturnType<typeof clackSpinner> | undefined;
  let currentLabel = "";
  let startedAt = Date.now();
  let stepActive = false;

  const prefix = (options?: StepOptions): string => {
    autoStep += 1;
    const step = options?.step ?? autoStep;
    return options?.total ? `[${step}/${options.total}] ` : `[${step}] `;
  };

  return {
    start(label, options) {
      currentLabel = label;
      startedAt = Date.now();
      stepActive = true;
      const line = `${prefix(options)}${label}`;
      if (isInteractive()) {
        active = clackSpinner({ indicator: "timer" });
        active.start(line);
      } else {
        console.log(line);
      }
    },
    succeed(label) {
      const text = label ?? currentLabel;
      stepActive = false;
      if (isInteractive() && active) {
        active.stop(theme.ok(text));
        active = undefined;
      } else {
        const elapsed = theme.dim(` ${formatElapsed(startedAt)}`);
        console.log(`${theme.ok(`${symbol("ok")} ${text}`)}${elapsed}`);
      }
    },
    fail(label) {
      const text = label ?? currentLabel;
      stepActive = false;
      if (isInteractive() && active) {
        active.error(text);
        active = undefined;
      } else {
        console.log(theme.danger(`${symbol("fail")} ${text}`));
      }
    },
    info(label) {
      if (isInteractive() && active) {
        active.message(label);
      } else {
        console.log(theme.accent(stepActive ? `  ${label}` : label));
      }
    },
  };
}
