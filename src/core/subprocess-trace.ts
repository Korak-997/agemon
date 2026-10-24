import { redactSecretsInText } from "../inspect/redact.js";
import type { StepSpinner } from "../ui/spinner.js";
import type {
  RunSubprocessOptions,
  SubprocessResult,
} from "./subprocess-runner.js";
import { printable } from "./untrusted-text.js";

const TRACED_LINES_PER_STREAM = 20;
const TRACED_LINE_MAX_CHARACTERS = 300;
const CONTROL_SEQUENCE_INTRODUCER = `(?:${String.fromCharCode(27)}\\[|${String.fromCharCode(0x9b)})`;
const TERMINAL_ESCAPE_SEQUENCE = new RegExp(
  `${CONTROL_SEQUENCE_INTRODUCER}[0-9;?]*[ -/]*[@-~]`,
  "g",
);

export type RunSubprocess = (
  command: string,
  args: string[],
  options?: RunSubprocessOptions,
) => Promise<SubprocessResult>;

function safeText(text: string): string {
  return printable(
    redactSecretsInText(text.replace(TERMINAL_ESCAPE_SEQUENCE, "")),
  );
}

function capLine(line: string): string {
  return line.length > TRACED_LINE_MAX_CHARACTERS
    ? `${line.slice(0, TRACED_LINE_MAX_CHARACTERS)}…`
    : line;
}

function tailLines(stream: string, prefix: string): string[] {
  const lines = safeText(stream).split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const earlierCount = lines.length - TRACED_LINES_PER_STREAM;
  const shown = lines.slice(Math.max(earlierCount, 0));
  return [
    ...(earlierCount > 0 ? [`│ … ${earlierCount} earlier lines`] : []),
    ...shown.map((line) => `│ ${prefix}${capLine(line)}`),
  ];
}

export function traceSubprocessCalls(
  run: RunSubprocess,
  ui: Pick<StepSpinner, "info">,
): RunSubprocess {
  return async (command, args, options) => {
    const result = await run(command, args, options);
    const lines = [
      `$ ${capLine(safeText([command, ...args].join(" ")))} (exit ${result.code})`,
      ...tailLines(result.stdout, ""),
      ...tailLines(result.stderr, "! "),
    ];
    for (const line of lines) {
      ui.info(line);
    }
    return result;
  };
}
