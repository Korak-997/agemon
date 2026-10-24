import { spawn } from "node:child_process";

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunSubprocessOptions {
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  cwd?: string;
  env?: Record<string, string>;
}

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 300_000;
export const MAX_CAPTURED_CHARACTERS_PER_STREAM = 10 * 1024 * 1024;
const TRUNCATION_MARKER = "\n…[truncated]";
const HARD_KILL_GRACE_MS = 2_000;
const STREAM_DRAIN_GRACE_MS = 2_000;
const TIMEOUT_EXIT_CODE = 124;

interface BoundedCapture {
  append(chunk: string): void;
  readonly text: string;
}

function sliceWithoutSplittingSurrogatePair(
  text: string,
  length: number,
): string {
  const lastKeptCodeUnit = text.charCodeAt(length - 1);
  const endsWithHighSurrogate =
    lastKeptCodeUnit >= 0xd800 && lastKeptCodeUnit <= 0xdbff;
  return text.slice(0, endsWithHighSurrogate ? length - 1 : length);
}

function createBoundedCapture(): BoundedCapture {
  let text = "";
  let truncated = false;
  return {
    append(chunk) {
      if (truncated) {
        return;
      }
      const remainingCharacters =
        MAX_CAPTURED_CHARACTERS_PER_STREAM - text.length;
      if (chunk.length <= remainingCharacters) {
        text += chunk;
        return;
      }
      text += `${sliceWithoutSplittingSurrogatePair(chunk, remainingCharacters)}${TRUNCATION_MARKER}`;
      truncated = true;
    },
    get text() {
      return text;
    },
  };
}

export async function runSubprocess(
  command: string,
  args: string[],
  options: RunSubprocessOptions = {},
): Promise<SubprocessResult> {
  if (process.env.AGEMON_FAKE_SUBPROCESS === "1") {
    const { runFakeSubprocess } = await import("./fake-subprocess.js");
    return runFakeSubprocess(command, args);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;

  return await new Promise<SubprocessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let hardKillHandle: NodeJS.Timeout | undefined;
    let drainHandle: NodeJS.Timeout | undefined;
    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();

    const clearTimers = (): void => {
      clearTimeout(timeoutHandle);
      clearTimeout(hardKillHandle);
      clearTimeout(drainHandle);
    };

    const finalize = (result: SubprocessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve(result);
    };

    const resultForExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): SubprocessResult => {
      if (timedOut) {
        const timeoutMessage = `Command timed out after ${timeoutMs}ms.`;
        return {
          code: TIMEOUT_EXIT_CODE,
          stdout: stdout.text,
          stderr: stderr.text
            ? `${stderr.text}\n${timeoutMessage}`
            : timeoutMessage,
        };
      }

      if (signal) {
        return {
          code: 1,
          stdout: stdout.text,
          stderr: `${stderr.text}Process terminated by signal: ${signal}`,
        };
      }

      return { code: code ?? 1, stdout: stdout.text, stderr: stderr.text };
    };

    const finalizeAfterDrainGrace = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      clearTimeout(drainHandle);
      drainHandle = setTimeout(() => {
        childProcess.stdout.destroy();
        childProcess.stderr.destroy();
        finalize(resultForExit(code, signal));
      }, STREAM_DRAIN_GRACE_MS);
    };

    const childProcess = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const signal = options.killSignal ?? "SIGTERM";
        const terminated = childProcess.kill(signal);
        if (!terminated) {
          finalize({
            code: TIMEOUT_EXIT_CODE,
            stdout: stdout.text,
            stderr: `${stderr.text}\nCommand timed out after ${timeoutMs}ms and could not be signaled with ${signal}.`,
          });
          return;
        }

        hardKillHandle = setTimeout(() => {
          childProcess.kill("SIGKILL");
          finalizeAfterDrainGrace(null, "SIGKILL");
        }, HARD_KILL_GRACE_MS);
      }, timeoutMs);
    }

    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk: string) => stdout.append(chunk));
    childProcess.stderr.on("data", (chunk: string) => stderr.append(chunk));

    childProcess.on("error", (error: Error) => {
      const errorMessage = stderr.text
        ? `${stderr.text}\nprocess spawn error: ${error.message}`
        : `process spawn error: ${error.message}`;
      finalize({ code: 1, stdout: stdout.text, stderr: errorMessage });
    });

    childProcess.on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeoutHandle);
        clearTimeout(hardKillHandle);
        finalizeAfterDrainGrace(code, signal);
      },
    );

    childProcess.on(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        finalize(resultForExit(code, signal));
      },
    );
  });
}
