import { spawn } from "node:child_process";

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export async function runSubprocess(
  command: string,
  args: string[],
): Promise<SubprocessResult> {
  if (process.env.AGEMON_FAKE_SUBPROCESS === "1") {
    return {
      code: 0,
      stdout: `[fake subprocess] ${formatCommand(command, args)}\n`,
      stderr: "",
    };
  }

  return await new Promise<SubprocessResult>((resolve) => {
    const childProcess = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    childProcess.stdout.on("data", (chunk: Buffer | string) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });

    childProcess.stderr.on("data", (chunk: Buffer | string) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });

    childProcess.on("error", (error: Error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });

    childProcess.on(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal) {
          resolve({
            code: 1,
            stdout,
            stderr: `${stderr}Process terminated by signal: ${signal}`,
          });
          return;
        }

        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      },
    );
  });
}
