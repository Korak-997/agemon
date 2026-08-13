import { spawn } from "node:child_process";

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

let fakeCrgInstalledState: boolean | null = null;

function initializeFakeStateIfNeeded(): void {
  if (fakeCrgInstalledState !== null) {
    return;
  }
  fakeCrgInstalledState = process.env.AGEMON_FAKE_PREINSTALLED_CRG === "1";
}

function buildFakeCrgResponse(args: string[]): SubprocessResult {
  if (!fakeCrgInstalledState) {
    return {
      code: 1,
      stdout: "",
      stderr: "code-review-graph: command not found",
    };
  }

  if (args[0] === "status") {
    return {
      code: 0,
      stdout: "Files: 1\nNodes: 1\nEdges: 1\n",
      stderr: "",
    };
  }

  if (args[0] === "build") {
    return {
      code: 0,
      stdout: "Graph build complete\n",
      stderr: "",
    };
  }

  return {
    code: 0,
    stdout: "code-review-graph 0.0.0-fake\n",
    stderr: "",
  };
}

function buildFakePipxResponse(args: string[]): SubprocessResult | undefined {
  if (
    args[0] === "run" &&
    args[1] === "--spec" &&
    args[2] === "code-review-graph" &&
    args[3] === "code-review-graph"
  ) {
    return buildFakeCrgResponse(args.slice(4));
  }

  const [operation, packageName] = args;
  if (packageName !== "code-review-graph") {
    return undefined;
  }

  if (operation === "install") {
    fakeCrgInstalledState = true;
    return {
      code: 0,
      stdout: "installed package code-review-graph\n",
      stderr: "",
    };
  }

  if (operation === "uninstall") {
    fakeCrgInstalledState = false;
    return {
      code: 0,
      stdout: "uninstalled package code-review-graph\n",
      stderr: "",
    };
  }

  return undefined;
}

export async function runSubprocess(
  command: string,
  args: string[],
): Promise<SubprocessResult> {
  if (process.env.AGEMON_FAKE_SUBPROCESS === "1") {
    initializeFakeStateIfNeeded();

    if (command === "pipx") {
      const pipxResponse = buildFakePipxResponse(args);
      if (pipxResponse) {
        return pipxResponse;
      }
    }

    if (command === "code-review-graph") {
      return buildFakeCrgResponse(args);
    }

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
