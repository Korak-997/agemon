import ora, { type Ora } from "ora";
import { theme } from "./theme.js";

export interface StepSpinner {
  start(label: string): void;
  succeed(label?: string): void;
  fail(label?: string): void;
  info(label: string): void;
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function createStepSpinner(): StepSpinner {
  let step = 0;
  let current: Ora | undefined;

  return {
    start(label) {
      step += 1;
      const prefixed = `[${step}] ${label}`;
      if (isInteractive()) {
        current = ora(prefixed).start();
      } else {
        console.log(prefixed);
      }
    },
    succeed(label) {
      const text = label ?? current?.text ?? "";
      if (isInteractive() && current) {
        current.succeed(text);
      } else {
        console.log(theme.success(`✔ ${text}`));
      }
    },
    fail(label) {
      const text = label ?? current?.text ?? "";
      if (isInteractive() && current) {
        current.fail(text);
      } else {
        console.log(theme.error(`✘ ${text}`));
      }
    },
    info(label) {
      if (isInteractive() && current) {
        current.info(label);
      } else {
        console.log(theme.info(label));
      }
    },
  };
}
