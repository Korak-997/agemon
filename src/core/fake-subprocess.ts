import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { resolveHomeDirectory } from "../platform/home.js";
import {
  AGNIX_VERSION,
  CODE_REVIEW_GRAPH_PACKAGE_SPEC,
  CODE_REVIEW_GRAPH_VERSION,
  ESSENTIALS_SKILLS_COMMIT,
} from "../plugins/pins.js";
import { SKILL_GROUPS } from "../plugins/skills/catalog.js";
import { skillPathInRepository } from "../plugins/skills/pinned-source.js";
import { isLeftOutBySkillsCli } from "../plugins/skills/skill-tree.js";
import { SKILLS_CLI_PATH_IN_TOOLS_DIR } from "../plugins/skills/skills-cli.js";
import {
  CANONICAL_SKILLS_DIRECTORY,
  CLAUDE_SKILLS_DIRECTORY,
  SKILLS_LOCK_FILE,
} from "../plugins/skills/skills-cli-targets.js";
import { isPlainSkillName } from "./config.js";
import {
  FAKE_PINNED_SKILL_MANIFEST_FILE,
  fakePinnedSkillManifest,
} from "./fake-pinned-skills.js";
import { sha256Hex } from "./fingerprint.js";
import { resolveStateRoot } from "./state-root.js";
import type { SubprocessResult } from "./subprocess-runner.js";
import type {
  VerifiedBinaryInstaller,
  VerifiedBinaryInstallRequest,
} from "./verified-binary-installer.js";

const FAKE_CRG_ON_PATH = "/fake/bin/code-review-graph";
const PINNED_SKILLS_CLI_SUFFIX = `/${SKILLS_CLI_PATH_IN_TOOLS_DIR}`;
const FAKE_LOCK_VERSION = 1;

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

let fakeCrgInstalledState: boolean | null = null;
let fakeInstalledGlobalNpmPackageNames: Set<string> | null = null;
let fakeVersionedAgentBinaryNames: Set<string> | null = null;
let fakeUsableAgentBinaryNames: Set<string> | null = null;
let fakeStateSignature: string | null = null;
let fakeVerifiedBinaryInstallRequests: VerifiedBinaryInstallRequest[] = [];

function buildFakeStateSignature(): string {
  return [
    process.env.AGEMON_FAKE_PREINSTALLED_CRG ?? "",
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES ?? "",
    process.env.AGEMON_FAKE_INSTALLED_AGENTS ?? "",
    process.env.AGEMON_FAKE_USABLE_AGENTS ?? "",
  ].join("||");
}

function fakeGlobalNpmStatePath(): string {
  return join(resolveStateRoot(), "agemon-fake", "npm-global.json");
}

function saveFakeGlobalNpmPackages(): void {
  if (fakeInstalledGlobalNpmPackageNames?.size === 0) {
    rmSync(fakeGlobalNpmStatePath(), { force: true });
    return;
  }
  mkdirSync(dirname(fakeGlobalNpmStatePath()), { recursive: true });
  writeFileSync(
    fakeGlobalNpmStatePath(),
    JSON.stringify([...(fakeInstalledGlobalNpmPackageNames ?? [])]),
  );
}

function loadSavedFakeGlobalNpmPackages(): string[] | null {
  if (!existsSync(fakeGlobalNpmStatePath())) {
    return null;
  }
  return JSON.parse(readFileSync(fakeGlobalNpmStatePath(), "utf8"));
}

export function resetFakeSubprocessState(): void {
  rmSync(fakeGlobalNpmStatePath(), { force: true });
  fakeCrgInstalledState = null;
  fakeInstalledGlobalNpmPackageNames = null;
  fakeVersionedAgentBinaryNames = null;
  fakeUsableAgentBinaryNames = null;
  fakeStateSignature = null;
  fakeVerifiedBinaryInstallRequests = [];
}

export function createFakeVerifiedBinaryInstaller(): VerifiedBinaryInstaller {
  return {
    async install(request) {
      initializeFakeStateIfNeeded();
      fakeVerifiedBinaryInstallRequests.push(request);
      fakeInstalledGlobalNpmPackageNames?.add(request.packageName);
      saveFakeGlobalNpmPackages();
    },
    async inspect(request) {
      initializeFakeStateIfNeeded();
      return fakeInstalledGlobalNpmPackageNames?.has(request.packageName)
        ? { kind: "installed", version: AGNIX_VERSION, differences: [] }
        : { kind: "absent" };
    },
  };
}

export function takeFakeVerifiedBinaryInstallRequests(): VerifiedBinaryInstallRequest[] {
  return fakeVerifiedBinaryInstallRequests.splice(0);
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

  const preinstalledGlobalNpmPackages =
    process.env.AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES?.split(",")
      .map((packageName) => packageName.trim())
      .filter((packageName) => packageName.length > 0);
  fakeInstalledGlobalNpmPackageNames = new Set(
    loadSavedFakeGlobalNpmPackages() ?? preinstalledGlobalNpmPackages ?? [],
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

function declaredSkillName(
  manifestPath: string,
  directoryName: string,
): string {
  const nameLine = readFileSync(manifestPath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("name:"));
  return nameLine?.slice("name:".length).trim() || directoryName;
}

function installedSkillNamesIn(skillsDirectory: string): string[] {
  if (!existsSync(skillsDirectory)) {
    return [];
  }
  return readdirSync(skillsDirectory).flatMap((directoryName) => {
    const manifestPath = join(skillsDirectory, directoryName, "SKILL.md");
    return existsSync(manifestPath)
      ? [declaredSkillName(manifestPath, directoryName)]
      : [];
  });
}

function buildFakeSkillsList(cwd: string): SubprocessResult {
  const names = new Set([
    ...installedSkillNamesIn(join(cwd, CANONICAL_SKILLS_DIRECTORY)),
    ...installedSkillNamesIn(join(cwd, CLAUDE_SKILLS_DIRECTORY)),
  ]);
  const skills = [...names].sort().map((name) => ({
    name,
    path: join(cwd, CLAUDE_SKILLS_DIRECTORY, name),
    scope: "project",
    agents: ["Claude Code"],
  }));

  return {
    code: 0,
    stdout: `${JSON.stringify(skills, null, 2)}\n`,
    stderr: "",
  };
}

function removeInstalledCopy(copyPath: string): void {
  const stats = lstatSync(copyPath, { throwIfNoEntry: false });
  if (stats?.isSymbolicLink()) {
    unlinkSync(copyPath);
  } else if (stats !== undefined) {
    rmSync(copyPath, { recursive: true, force: true });
  }
}

function copyLikeSkillsCli(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === source || !isLeftOutBySkillsCli(basename(path), statSync(path)),
  });
}

function readFakeLockSkills(cwd: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(cwd, SKILLS_LOCK_FILE), "utf8"),
    );
    return parsed.version === FAKE_LOCK_VERSION && parsed.skills
      ? parsed.skills
      : {};
  } catch {
    return {};
  }
}

function writeFakeLockLikeSkillsCli(
  cwd: string,
  skills: Record<string, unknown>,
): void {
  const sortedSkills = Object.fromEntries(
    Object.keys(skills)
      .sort()
      .map((name) => [name, skills[name]]),
  );
  writeFileSync(
    join(cwd, SKILLS_LOCK_FILE),
    `${JSON.stringify({ version: FAKE_LOCK_VERSION, skills: sortedSkills }, null, 2)}\n`,
  );
}

function fakeLockEntry(packageSource: string, cwd: string) {
  const isLocal = existsSync(packageSource);
  const source = isLocal ? relative(cwd, packageSource) : packageSource;
  return {
    source,
    sourceType: isLocal ? "local" : "github",
    computedHash: sha256Hex(source),
  };
}

function refusedSkillName(skillName: string): SubprocessResult {
  return {
    code: 1,
    stdout: "",
    stderr: `the fake skills CLI refuses the skill name ${JSON.stringify(skillName)}`,
  };
}

function buildFakeSkillsAdd(args: string[], cwd: string): SubprocessResult {
  const packageSource = args[1];
  if (!packageSource) {
    return {
      code: 1,
      stdout: "",
      stderr: "skills add requires a package source",
    };
  }

  const skillName = readOptionValue(args, "--skill") ?? packageSource;
  if (!isPlainSkillName(skillName)) {
    return refusedSkillName(skillName);
  }
  const copyPath = join(cwd, CLAUDE_SKILLS_DIRECTORY, skillName);
  removeInstalledCopy(copyPath);
  mkdirSync(dirname(copyPath), { recursive: true });
  if (existsSync(packageSource)) {
    copyLikeSkillsCli(packageSource, copyPath);
  } else {
    mkdirSync(copyPath);
    writeFileSync(
      join(copyPath, "SKILL.md"),
      `---\nname: ${skillName}\n---\n`,
      "utf8",
    );
  }
  writeFakeLockLikeSkillsCli(cwd, {
    ...readFakeLockSkills(cwd),
    [skillName]: fakeLockEntry(packageSource, cwd),
  });

  return {
    code: 0,
    stdout: `installed skill ${skillName} from ${packageSource}\n`,
    stderr: "",
  };
}

function buildFakeSkillsRemove(args: string[], cwd: string): SubprocessResult {
  const agentName = readOptionValue(args, "--agent");
  const skillNames = args
    .slice(1)
    .filter(
      (arg) => arg.length > 0 && !arg.startsWith("-") && arg !== agentName,
    );

  const unsafeName = skillNames.find(
    (skillName) => !isPlainSkillName(skillName),
  );
  if (unsafeName !== undefined) {
    return refusedSkillName(unsafeName);
  }
  for (const skillName of skillNames) {
    removeInstalledCopy(join(cwd, CLAUDE_SKILLS_DIRECTORY, skillName));
    rmSync(join(cwd, CANONICAL_SKILLS_DIRECTORY, skillName), {
      recursive: true,
      force: true,
    });
    const lockSkills = readFakeLockSkills(cwd);
    if (Object.hasOwn(lockSkills, skillName)) {
      delete lockSkills[skillName];
      writeFakeLockLikeSkillsCli(cwd, lockSkills);
    }
  }

  return {
    code: 0,
    stdout: `removed ${skillNames.length} skill(s)\n`,
    stderr: "",
  };
}

function buildFakeSkillsCliResponse(
  args: string[],
  cwd: string | undefined,
): SubprocessResult {
  const subcommand = args[0];
  const needsRepository = ["list", "ls", "add", "remove", "rm"].includes(
    subcommand ?? "",
  );
  if (needsRepository && cwd === undefined) {
    return {
      code: 1,
      stdout: "",
      stderr: "the fake skills CLI needs the repository as its cwd",
    };
  }
  if (cwd !== undefined && (subcommand === "list" || subcommand === "ls")) {
    return buildFakeSkillsList(cwd);
  }

  if (cwd !== undefined && subcommand === "add") {
    return buildFakeSkillsAdd(args, cwd);
  }

  if (cwd !== undefined && (subcommand === "remove" || subcommand === "rm")) {
    return buildFakeSkillsRemove(args, cwd);
  }

  return {
    code: 0,
    stdout: `[fake subprocess] skills ${args.join(" ")}\n`,
    stderr: "",
  };
}

function writeFakePinnedSkills(sourceDirectory: string): void {
  const commit = basename(sourceDirectory);
  for (const entry of SKILL_GROUPS.flatMap((group) => group.skills)) {
    if (entry.pinnedRepository?.commit !== commit) {
      continue;
    }
    const skillDirectory = join(
      sourceDirectory,
      skillPathInRepository(entry.skillName),
    );
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, FAKE_PINNED_SKILL_MANIFEST_FILE),
      fakePinnedSkillManifest(entry.skillName),
      "utf8",
    );
  }
}

export function fakePipxHome(): string {
  return join(resolveHomeDirectory(), ".agemon", "fake-pipx");
}

function fakeCrgVenvPath(): string {
  return join(fakePipxHome(), "venvs", "code-review-graph");
}

function fakeCrgStubPath(): string {
  return join(fakeCrgVenvPath(), "bin", "code-review-graph");
}

export function fakeCodeReviewGraphOnPath(): string | undefined {
  initializeFakeStateIfNeeded();
  if (existsSync(fakeCrgStubPath())) {
    return fakeCrgStubPath();
  }
  return fakeCrgInstalledState ? FAKE_CRG_ON_PATH : undefined;
}

function splitPipArgs(args: string[]): string[] {
  const pipArgsFlag = args.find((arg) => arg.startsWith("--pip-args="));
  if (pipArgsFlag === undefined) {
    return [];
  }
  return [
    ...pipArgsFlag.slice("--pip-args=".length).matchAll(/'([^']*)'|(\S+)/g),
  ].map((match) => match[1] ?? match[2]);
}

function writeFakeCrgVenv(pipArgs: string[]): void {
  const metadataPath = join(fakeCrgVenvPath(), "pipx_metadata.json");
  if (existsSync(metadataPath)) {
    return;
  }
  mkdirSync(dirname(fakeCrgStubPath()), { recursive: true });
  writeFileSync(fakeCrgStubPath(), "#!/bin/sh\n", { flag: "wx", mode: 0o755 });
  writeFileSync(join(fakeCrgVenvPath(), "bin", "python"), "#!/bin/sh\n", {
    flag: "wx",
    mode: 0o755,
  });
  const metadata = {
    main_package: {
      package: "code-review-graph",
      package_version: CODE_REVIEW_GRAPH_VERSION,
      app_paths: [{ __Path__: fakeCrgStubPath(), __type__: "Path" }],
      pip_args: pipArgs,
    },
    pipx_metadata_version: "0.3",
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: "wx",
  });
}

function buildFakeGraph(cwd: string | undefined): void {
  if (cwd === undefined) {
    return;
  }
  const graphDirectory = join(cwd, ".code-review-graph");
  if (existsSync(graphDirectory)) {
    return;
  }
  mkdirSync(graphDirectory);
  writeFileSync(join(graphDirectory, "graph.db"), "fake graph\n", "utf8");
}

function buildFakeCrgResponse(
  command: string,
  args: string[],
  cwd: string | undefined,
): SubprocessResult {
  const installed =
    fakeCrgInstalledState || (isAbsolute(command) && existsSync(command));
  if (!installed) {
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
    buildFakeGraph(cwd);
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
  const [operation, packageName] = args;
  if (
    operation === "install" &&
    packageName === CODE_REVIEW_GRAPH_PACKAGE_SPEC
  ) {
    writeFakeCrgVenv(splitPipArgs(args));
    fakeCrgInstalledState = true;
    return {
      code: 0,
      stdout: "installed package code-review-graph\n",
      stderr: "",
    };
  }

  if (operation === "uninstall" && packageName === "code-review-graph") {
    rmSync(fakeCrgVenvPath(), { recursive: true, force: true });
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

function assertNpmIgnoresProjectConfig(args: string[]): void {
  const ignoresProjectConfig = args.some(
    (arg) =>
      arg === "--global" || arg === "--prefix" || arg.startsWith("--prefix="),
  );
  if (!ignoresProjectConfig) {
    throw new Error(
      `npm ${args.join(" ")} must pass --global or --prefix, so npm never reads a .npmrc from the repository it runs in.`,
    );
  }
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
  if (operation === "root" && hasGlobalFlag) {
    const fakeNpmRoot = join(resolveStateRoot(), "agemon-fake", "npm-root");
    mkdirSync(fakeNpmRoot, { recursive: true });
    return { code: 0, stdout: `${fakeNpmRoot}\n`, stderr: "" };
  }
  if (!hasGlobalFlag) {
    return {
      code: 0,
      stdout: `[fake subprocess] npm ${args.join(" ")}\n`,
      stderr: "",
    };
  }

  const packageNames = parseGlobalNpmPackageNames(args);

  if (operation === "install") {
    throw new Error(
      `npm install --global ${packageNames.join(" ")} installs by name; agemon installs global npm packages only from a verified tarball (ctx.verifiedBinaryInstaller).`,
    );
  }

  if (operation === "uninstall") {
    for (const packageName of packageNames) {
      fakeInstalledGlobalNpmPackageNames?.delete(packageName);
    }
    saveFakeGlobalNpmPackages();
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
  options: { cwd?: string } = {},
): SubprocessResult {
  initializeFakeStateIfNeeded();

  if (command === "pipx") {
    const pipxResponse = buildFakePipxResponse(args);
    if (pipxResponse) {
      return pipxResponse;
    }
  }

  if (args[0]?.endsWith(PINNED_SKILLS_CLI_SUFFIX)) {
    return buildFakeSkillsCliResponse(args.slice(1), options.cwd);
  }

  if (
    command === "git" &&
    args.at(-2) === "rev-parse" &&
    args.at(-1) === "HEAD"
  ) {
    return { code: 0, stdout: `${ESSENTIALS_SKILLS_COMMIT}\n`, stderr: "" };
  }

  if (
    command === "git" &&
    args.slice(-3).join(" ") === "checkout -q FETCH_HEAD" &&
    options.cwd !== undefined
  ) {
    writeFakePinnedSkills(options.cwd);
  }

  if (basename(command) === "npm") {
    assertNpmIgnoresProjectConfig(args);
  }
  if (command === "npm") {
    const npmResponse = buildFakeNpmResponse(args);
    if (npmResponse) {
      return npmResponse;
    }
  }

  if (command === "agnix") {
    return buildFakeAgnixResponse(args);
  }

  const commandBinaryName = basename(command);
  if (commandBinaryName === "code-review-graph") {
    return buildFakeCrgResponse(command, args, options.cwd);
  }

  if (FAKE_AGENT_BINARY_NAMES.has(commandBinaryName)) {
    return buildFakeAgentResponse(commandBinaryName, args);
  }

  return {
    code: 0,
    stdout: `[fake subprocess] ${formatCommand(command, args)}\n`,
    stderr: "",
  };
}
