import { spawn } from "node:child_process";

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunSubprocessOptions {
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

let fakeCrgInstalledState: boolean | null = null;
let fakeInstalledSkillNames: Set<string> | null = null;
let fakeInstalledGlobalNpmPackageNames: Set<string> | null = null;
let fakeStateSignature: string | null = null;

function buildFakeStateSignature(): string {
  return [
    process.env.AGEMON_FAKE_PREINSTALLED_CRG ?? "",
    process.env.AGEMON_FAKE_PREINSTALLED_SKILLS ?? "",
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES ?? "",
  ].join("||");
}

function initializeFakeStateIfNeeded(): void {
  const currentStateSignature = buildFakeStateSignature();
  if (
    fakeCrgInstalledState !== null &&
    fakeStateSignature === currentStateSignature
  ) {
    return;
  }
  fakeStateSignature = currentStateSignature;

  fakeCrgInstalledState = process.env.AGEMON_FAKE_PREINSTALLED_CRG === "1";

  const preinstalledSkills = process.env.AGEMON_FAKE_PREINSTALLED_SKILLS?.split(
    ",",
  )
    .map((skillName) => skillName.trim())
    .filter((skillName) => skillName.length > 0);
  fakeInstalledSkillNames = new Set(preinstalledSkills ?? []);

  const preinstalledGlobalNpmPackages =
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES?.split(",")
      .map((packageName) => packageName.trim())
      .filter((packageName) => packageName.length > 0);
  fakeInstalledGlobalNpmPackageNames = new Set(
    preinstalledGlobalNpmPackages ?? [],
  );
}

function readOptionValue(
  args: string[],
  optionName: string,
): string | undefined {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex < 0) {
    return undefined;
  }

  return args[optionIndex + 1];
}

function buildFakeSkillsList(): SubprocessResult {
  const skills = Array.from(fakeInstalledSkillNames ?? []).map((name) => ({
    name,
    path: `/fake/.claude/skills/${name}`,
    scope: "project",
    agents: ["Claude Code"],
  }));

  return {
    code: 0,
    stdout: `${JSON.stringify(skills, null, 2)}\n`,
    stderr: "",
  };
}

function buildFakeSkillsAdd(args: string[]): SubprocessResult {
  const packageSource = args[2];
  if (!packageSource) {
    return {
      code: 1,
      stdout: "",
      stderr: "skills add requires a package source",
    };
  }

  const skillName = readOptionValue(args, "--skill") ?? packageSource;
  fakeInstalledSkillNames?.add(skillName);

  return {
    code: 0,
    stdout: `installed skill ${skillName} from ${packageSource}\n`,
    stderr: "",
  };
}

function buildFakeSkillsRemove(args: string[]): SubprocessResult {
  const skillNames = args
    .slice(2)
    .filter((arg) => arg.length > 0 && !arg.startsWith("-"));

  for (const skillName of skillNames) {
    fakeInstalledSkillNames?.delete(skillName);
  }

  return {
    code: 0,
    stdout: `removed ${skillNames.length} skill(s)\n`,
    stderr: "",
  };
}

function buildFakeNpxResponse(args: string[]): SubprocessResult | undefined {
  if (args[0] !== "skills") {
    return undefined;
  }

  const subcommand = args[1];
  if (subcommand === "list" || subcommand === "ls") {
    return buildFakeSkillsList();
  }

  if (subcommand === "add") {
    return buildFakeSkillsAdd(args);
  }

  if (subcommand === "remove" || subcommand === "rm") {
    return buildFakeSkillsRemove(args);
  }

  return {
    code: 0,
    stdout: `[fake subprocess] npx ${args.join(" ")}\n`,
    stderr: "",
  };
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

function parseGlobalNpmPackageNames(args: string[]): string[] {
  const packageNames: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg.startsWith("-")) {
      continue;
    }
    packageNames.push(arg);
  }

  return packageNames;
}

function buildFakeNpmResponse(args: string[]): SubprocessResult | undefined {
  const operation = args[0];
  if (!operation) {
    return undefined;
  }

  const hasGlobalFlag = args.includes("-g") || args.includes("--global");
  if (!hasGlobalFlag) {
    return {
      code: 0,
      stdout: `[fake subprocess] npm ${args.join(" ")}\n`,
      stderr: "",
    };
  }

  const packageNames = parseGlobalNpmPackageNames(args);

  if (operation === "install") {
    for (const packageName of packageNames) {
      fakeInstalledGlobalNpmPackageNames?.add(packageName);
    }
    return {
      code: 0,
      stdout: `installed ${packageNames.length} package(s) globally\n`,
      stderr: "",
    };
  }

  if (operation === "uninstall") {
    for (const packageName of packageNames) {
      fakeInstalledGlobalNpmPackageNames?.delete(packageName);
    }
    return {
      code: 0,
      stdout: `removed ${packageNames.length} package(s) globally\n`,
      stderr: "",
    };
  }

  return {
    code: 0,
    stdout: `[fake subprocess] npm ${args.join(" ")}\n`,
    stderr: "",
  };
}

function buildFakeAgnixResponse(args: string[]): SubprocessResult {
  if (!fakeInstalledGlobalNpmPackageNames?.has("agnix")) {
    return {
      code: 1,
      stdout: "",
      stderr: "agnix: command not found",
    };
  }

  if (args[0] === "--version") {
    return {
      code: 0,
      stdout: "agnix 0.0.0-fake\n",
      stderr: "",
    };
  }

  if (args[0] === "lint") {
    return {
      code: 0,
      stdout: "agnix lint passed\n",
      stderr: "",
    };
  }

  return {
    code: 0,
    stdout: `[fake subprocess] agnix ${args.join(" ")}\n`,
    stderr: "",
  };
}

export async function runSubprocess(
  command: string,
  args: string[],
  options: RunSubprocessOptions = {},
): Promise<SubprocessResult> {
  if (process.env.AGEMON_FAKE_SUBPROCESS === "1") {
    initializeFakeStateIfNeeded();

    if (command === "pipx") {
      const pipxResponse = buildFakePipxResponse(args);
      if (pipxResponse) {
        return pipxResponse;
      }
    }

    if (command === "npx") {
      const npxResponse = buildFakeNpxResponse(args);
      if (npxResponse) {
        return npxResponse;
      }
    }

    if (command === "npm") {
      const npmResponse = buildFakeNpmResponse(args);
      if (npmResponse) {
        return npmResponse;
      }
    }

    if (command === "code-review-graph") {
      return buildFakeCrgResponse(args);
    }

    if (command === "agnix") {
      return buildFakeAgnixResponse(args);
    }

    return {
      code: 0,
      stdout: `[fake subprocess] ${formatCommand(command, args)}\n`,
      stderr: "",
    };
  }

  return await new Promise<SubprocessResult>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let hardKillHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const finalize = (result: SubprocessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (hardKillHandle) {
        clearTimeout(hardKillHandle);
      }
      resolve(result);
    };

    const childProcess = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const signal = options.killSignal ?? "SIGTERM";
        const terminated = childProcess.kill(signal);
        if (!terminated) {
          finalize({
            code: 124,
            stdout,
            stderr: `${stderr}\nCommand timed out after ${options.timeoutMs}ms and could not be signaled with ${signal}.`,
          });
          return;
        }

        hardKillHandle = setTimeout(() => {
          if (!settled) {
            childProcess.kill("SIGKILL");
          }
        }, 2_000);
      }, options.timeoutMs);
    }

    let stdout = "";
    let stderr = "";

    childProcess.stdout.on("data", (chunk: Buffer | string) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });

    childProcess.stderr.on("data", (chunk: Buffer | string) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });

    childProcess.on("error", (error: Error) => {
      const errorMessage = stderr
        ? `${stderr}\nprocess spawn error: ${error.message}`
        : `process spawn error: ${error.message}`;
      finalize({
        code: 1,
        stdout,
        stderr: errorMessage,
      });
    });

    childProcess.on(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          const timeoutMessage = `Command timed out after ${options.timeoutMs}ms.`;
          const timeoutStderr = stderr
            ? `${stderr}\n${timeoutMessage}`
            : timeoutMessage;
          finalize({
            code: 124,
            stdout,
            stderr: timeoutStderr,
          });
          return;
        }

        if (signal) {
          finalize({
            code: 1,
            stdout,
            stderr: `${stderr}Process terminated by signal: ${signal}`,
          });
          return;
        }

        finalize({
          code: code ?? 1,
          stdout,
          stderr,
        });
      },
    );
  });
}
