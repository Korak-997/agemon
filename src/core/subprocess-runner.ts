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
let fakeInstalledSkillNames: Set<string> | null = null;

function initializeFakeStateIfNeeded(): void {
  if (fakeCrgInstalledState !== null) {
    return;
  }
  fakeCrgInstalledState = process.env.AGEMON_FAKE_PREINSTALLED_CRG === "1";

  const preinstalledSkills = process.env.AGEMON_FAKE_PREINSTALLED_SKILLS
    ?.split(",")
    .map((skillName) => skillName.trim())
    .filter((skillName) => skillName.length > 0);
  fakeInstalledSkillNames = new Set(preinstalledSkills ?? []);
}

function readOptionValue(args: string[], optionName: string): string | undefined {
  const optionIndex = args.findIndex((arg) => arg === optionName);
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

    if (command === "npx") {
      const npxResponse = buildFakeNpxResponse(args);
      if (npxResponse) {
        return npxResponse;
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
