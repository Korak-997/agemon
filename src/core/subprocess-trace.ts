import type { StepSpinner } from "../ui/spinner.js";
import {
  capShownLine,
  MAX_RAW_OUTPUT_LINE_CHARACTERS,
  type RunSubprocessOptions,
  type SubprocessResult,
  safeOutputTail,
  sanitizeOutput,
} from "./subprocess-runner.js";

const TRACED_LINES_PER_STREAM = 20;

export type RunSubprocess = (
  command: string,
  args: string[],
  options?: RunSubprocessOptions,
) => Promise<SubprocessResult>;

function tailLines(stream: string, prefix: string): string[] {
  const { earlierLineCount, lines } = safeOutputTail(
    stream,
    TRACED_LINES_PER_STREAM,
  );
  return [
    ...(earlierLineCount > 0 ? [`│ … ${earlierLineCount} earlier lines`] : []),
    ...lines.map((line) => `│ ${prefix}${line}`),
  ];
}

function describeCommandLine(command: string, args: string[]): string {
  const commandLine = [command, ...args]
    .join(" ")
    .slice(0, MAX_RAW_OUTPUT_LINE_CHARACTERS);
  return capShownLine(sanitizeOutput(commandLine));
}

export function traceSubprocessCalls(
  run: RunSubprocess,
  ui: Pick<StepSpinner, "info">,
): RunSubprocess {
  return async (command, args, options) => {
    const result = await run(command, args, options);
    const lines = [
      `$ ${describeCommandLine(command, args)} (exit ${result.code})`,
      ...tailLines(result.stdout, ""),
      ...tailLines(result.stderr, "! "),
    ];
    for (const line of lines) {
      ui.info(line);
    }
    return result;
  };
}
