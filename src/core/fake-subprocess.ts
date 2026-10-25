import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CODE_REVIEW_GRAPH_PACKAGE_SPEC,
  ESSENTIALS_SKILLS_COMMIT,
} from "../plugins/pins.js";
import { SKILLS_CLI_PATH_IN_TOOLS_DIR } from "../plugins/skills/skills-cli.js";
import type { SubprocessResult } from "./subprocess-runner.js";

const PINNED_SKILLS_CLI_SUFFIX = `/${SKILLS_CLI_PATH_IN_TOOLS_DIR}`;

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

let fakeCrgInstalledState: boolean | null = null;
let fakeInstalledSkillNames: Set<string> | null = null;
let fakeInstalledGlobalNpmPackageNames: Set<string> | null = null;
let fakeVersionedAgentBinaryNames: Set<string> | null = null;
let fakeUsableAgentBinaryNames: Set<string> | null = null;
let fakeStateSignature: string | null = null;

function buildFakeStateSignature(): string {
  return [
    process.env.AGEMON_FAKE_PREINSTALLED_CRG ?? "",
    process.env.AGEMON_FAKE_PREINSTALLED_SKILLS ?? "",
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES ?? "",
    process.env.AGEMON_FAKE_INSTALLED_AGENTS ?? "",
    process.env.AGEMON_FAKE_USABLE_AGENTS ?? "",
  ].join("||");
}

export function resetFakeSubprocessState(): void {
  fakeCrgInstalledState = null;
  fakeInstalledSkillNames = null;
  fakeInstalledGlobalNpmPackageNames = null;
  fakeVersionedAgentBinaryNames = null;
  fakeUsableAgentBinaryNames = null;
  fakeStateSignature = null;
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

  const versionedAgentBinaryNames =
    process.env.AGEMON_FAKE_INSTALLED_AGENTS?.split(",")
      .map((binaryName) => binaryName.trim())
      .filter((binaryName) => binaryName.length > 0);
  fakeVersionedAgentBinaryNames = new Set(versionedAgentBinaryNames ?? []);

  const usableAgentBinaryNames = process.env.AGEMON_FAKE_USABLE_AGENTS?.split(
    ",",
  )
    .map((binaryName) => binaryName.trim())
    .filter((binaryName) => binaryName.length > 0);
  fakeUsableAgentBinaryNames = new Set(usableAgentBinaryNames ?? []);
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
  const packageSource = args[1];
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
    .slice(1)
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

function buildFakeSkillsCliResponse(args: string[]): SubprocessResult {
  const subcommand = args[0];
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
    stdout: `[fake subprocess] skills ${args.join(" ")}\n`,
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
    args[2] === CODE_REVIEW_GRAPH_PACKAGE_SPEC &&
    args[3] === "code-review-graph"
  ) {
    return buildFakeCrgResponse(args.slice(4));
  }

  const [operation, packageName] = args;
  if (
    operation === "install" &&
    packageName === CODE_REVIEW_GRAPH_PACKAGE_SPEC
  ) {
    fakeCrgInstalledState = true;
    return {
      code: 0,
      stdout: "installed package code-review-graph\n",
      stderr: "",
    };
  }

  if (operation === "uninstall" && packageName === "code-review-graph") {
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

function buildFakeNpmCi(args: string[]): SubprocessResult {
  const prefix = readOptionValue(args, "--prefix");
  if (prefix) {
    const cliPath = join(prefix, SKILLS_CLI_PATH_IN_TOOLS_DIR);
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, "", "utf8");
  }
  return {
    code: 0,
    stdout: `[fake subprocess] npm ${args.join(" ")}\n`,
    stderr: "",
  };
}

function buildFakeNpmResponse(args: string[]): SubprocessResult | undefined {
  const operation = args[0];
  if (!operation) {
    return undefined;
  }

  if (operation === "ci") {
    return buildFakeNpmCi(args);
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

const FAKE_AGENT_BINARY_NAMES: ReadonlySet<string> = new Set([
  "claude",
  "gemini",
]);

function buildFakeAgentVersionResponse(binaryName: string): SubprocessResult {
  if (fakeVersionedAgentBinaryNames?.has(binaryName)) {
    return {
      code: 0,
      stdout: `${binaryName} 1.0.0-fake\n`,
      stderr: "",
    };
  }

  return {
    code: 0,
    stdout: "unrecognized output\n",
    stderr: "",
  };
}

function buildFakeAgentUsabilityResponse(
  binaryName: string,
  args: string[],
): SubprocessResult {
  if (fakeUsableAgentBinaryNames?.has(binaryName)) {
    return {
      code: 0,
      stdout: `[fake subprocess] ${binaryName} ${args.join(" ")} ok\n`,
      stderr: "",
    };
  }

  return {
    code: 1,
    stdout: "",
    stderr: `${binaryName} ${args.join(" ")}: command failed\n`,
  };
}

function buildFakeAgentResponse(
  binaryName: string,
  args: string[],
): SubprocessResult {
  if (args[0] === "--version") {
    return buildFakeAgentVersionResponse(binaryName);
  }

  return buildFakeAgentUsabilityResponse(binaryName, args);
}

export function runFakeSubprocess(
  command: string,
  args: string[],
): SubprocessResult {
  initializeFakeStateIfNeeded();

  if (command === "pipx") {
    const pipxResponse = buildFakePipxResponse(args);
    if (pipxResponse) {
      return pipxResponse;
    }
  }

  if (args[0]?.endsWith(PINNED_SKILLS_CLI_SUFFIX)) {
    return buildFakeSkillsCliResponse(args.slice(1));
  }

  if (
    command === "git" &&
    args.at(-2) === "rev-parse" &&
    args.at(-1) === "HEAD"
  ) {
    return { code: 0, stdout: `${ESSENTIALS_SKILLS_COMMIT}\n`, stderr: "" };
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

  const commandBinaryName = basename(command);
  if (FAKE_AGENT_BINARY_NAMES.has(commandBinaryName)) {
    return buildFakeAgentResponse(commandBinaryName, args);
  }

  return {
    code: 0,
    stdout: `[fake subprocess] ${formatCommand(command, args)}\n`,
    stderr: "",
  };
}
