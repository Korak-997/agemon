import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { redactSecretsInText } from "../inspect/redact.js";
import type { UnreadableGitConfigCategory } from "../plugins/types.js";
import { sha256Hex } from "./fingerprint.js";
import { hasGitEntry } from "./repo-paths.js";
import {
  GIT_TRANSPORTS_DISABLED,
  HARDENED_GIT_ARGS,
  REPOSITORY_LOCAL_GIT_VARIABLES,
  runRepositoryGit,
} from "./repository-git.js";
import {
  describeSubprocessFailure,
  isSpawnFailure,
  runRealSubprocess,
  type SubprocessResult,
  TRUNCATION_MARKER,
} from "./subprocess-runner.js";
import {
  CLEAN_GIT_CONFIG,
  type GitConfigGuard,
  type GitConfigGuardResult,
  MAX_GIT_CONFIG_KEY_CHARACTERS,
  MAX_GIT_CONFIG_SOURCE_CHARACTERS,
  MAX_GIT_CONFIG_VALUE_CHARACTERS,
  MAX_UNTRUSTED_GIT_CONFIG_PAIR_CHARACTERS,
  MAX_UNTRUSTED_GIT_CONFIG_PAIRS,
} from "./untrusted-git-config.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const MAX_KEYS_PER_CONFIG_FILE = 4096;
const MAX_SUBMODULE_DEPTH = 8;
const MAX_SUBMODULES = 256;
const GIT_LISTING_TIMEOUT_MS = 5_000;
const GITLINK_MODE = "160000";
const SPARSE_DIRECTORY_MODE = "040000";
const REGULAR_BLOB_MODE = "100644";
const UNMERGED_STAGE_NONE = "0";
const REPLACEMENT_CHARACTER = "�";
const VALUELESS_BOOLEAN = "true";
const REV_PARSE_NO_SUCH_REVISION = 1;
const GIT_NOT_A_REPOSITORY = 128;

class UnreadableGitConfigError extends Error {
  constructor(
    readonly category: UnreadableGitConfigCategory,
    detail: string,
  ) {
    super(detail);
  }
}

interface Repository {
  worktree: string;
  gitDir: string;
  commonDir: string;
  isSubmodule: boolean;
}

interface ConfigRecord {
  source: string;
  key: string;
  value: string | null;
  owner: Repository;
}

interface IndexEntry {
  mode: string;
  stage: string;
  path: string;
}

interface Walk {
  repoRoot: string;
  neutralDirectory: string;
  submodulesSeen: number;
}

type ValueRule = (value: string) => boolean;

const anyValue: ValueRule = () => true;
const booleanValue: ValueRule = (value) =>
  /^(?:true|false|yes|no|on|off|1|0)$/i.test(value);
const oneOf =
  (...allowed: string[]): ValueRule =>
  (value) =>
    allowed.includes(value);
const either =
  (...rules: ValueRule[]): ValueRule =>
  (value) =>
    rules.some((rule) => rule(value));
const rebaseMode = either(booleanValue, oneOf("merges", "interactive"));

const KEYS_WITHOUT_SUBSECTION: ReadonlyMap<string, ValueRule> = new Map([
  ["core.repositoryformatversion", oneOf("0", "1")],
  ["core.filemode", booleanValue],
  ["core.bare", booleanValue],
  ["core.logallrefupdates", either(booleanValue, oneOf("always"))],
  ["core.ignorecase", booleanValue],
  ["core.precomposeunicode", booleanValue],
  ["core.symlinks", booleanValue],
  ["core.autocrlf", either(booleanValue, oneOf("input"))],
  ["core.eol", oneOf("lf", "crlf", "native")],
  ["core.sparsecheckout", booleanValue],
  ["core.sparsecheckoutcone", booleanValue],
  ["core.fsmonitor", booleanValue],
  ["core.hookspath", anyValue],
  ["extensions.objectformat", oneOf("sha1", "sha256")],
  ["extensions.worktreeconfig", booleanValue],
  ["extensions.partialclone", anyValue],
  ["user.name", anyValue],
  ["user.email", anyValue],
  ["submodule.active", anyValue],
  ["lfs.repositoryformatversion", oneOf("0")],
  ["pull.rebase", rebaseMode],
  ["pull.ff", either(booleanValue, oneOf("only"))],
  ["init.defaultbranch", anyValue],
  ["fetch.prune", booleanValue],
  [
    "push.default",
    oneOf("nothing", "current", "upstream", "simple", "matching"),
  ],
  ["rerere.enabled", booleanValue],
  ["gc.auto", (value) => /^-?\d+$/.test(value)],
]);

const KEYS_WITH_ANY_SUBSECTION: ReadonlyMap<string, ValueRule> = new Map([
  ["remote.url", anyValue],
  ["remote.pushurl", anyValue],
  ["remote.fetch", anyValue],
  ["remote.promisor", booleanValue],
  ["remote.partialclonefilter", anyValue],
  ["branch.remote", anyValue],
  ["branch.merge", anyValue],
  ["branch.rebase", rebaseMode],
  ["branch.vscode-merge-base", anyValue],
  ["submodule.url", anyValue],
  ["submodule.active", booleanValue],
  ["submodule.path", anyValue],
  ["submodule.branch", anyValue],
  ["submodule.shallow", booleanValue],
  ["submodule.ignore", oneOf("dirty", "all")],
  ["lfs.access", oneOf("basic", "negotiate", "none")],
  ["lfs.locksverify", booleanValue],
]);

const STOCK_GIT_LFS_FILTER: ReadonlyMap<string, ValueRule> = new Map([
  ["clean", oneOf("git-lfs clean -- %f")],
  ["smudge", oneOf("git-lfs smudge -- %f", "git-lfs smudge --skip -- %f")],
  ["process", oneOf("git-lfs filter-process", "git-lfs filter-process --skip")],
  ["required", oneOf("true")],
]);

const CREDENTIAL_CARRYING_KEYS: ReadonlySet<string> = new Set([
  "http.extraheader",
  "remote.url",
  "remote.pushurl",
  "credential.username",
]);

interface KeyParts {
  section: string;
  subsection: string | null;
  variable: string;
}

function splitKey(key: string): KeyParts | null {
  const firstDot = key.indexOf(".");
  const lastDot = key.lastIndexOf(".");
  if (firstDot <= 0 || lastDot === key.length - 1) {
    return null;
  }
  return {
    section: key.slice(0, firstDot).toLowerCase(),
    subsection: firstDot === lastDot ? null : key.slice(firstDot + 1, lastDot),
    variable: key.slice(lastDot + 1).toLowerCase(),
  };
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

async function isAllowlisted(record: ConfigRecord): Promise<boolean> {
  const parts = splitKey(record.key);
  if (parts === null) {
    return false;
  }
  const value = record.value ?? VALUELESS_BOOLEAN;
  const name = `${parts.section}.${parts.variable}`;
  if (parts.subsection === null) {
    if (name === "core.worktree") {
      return record.owner.isSubmodule;
    }
    return KEYS_WITHOUT_SUBSECTION.get(name)?.(value) ?? false;
  }
  if (parts.section === "filter" && parts.subsection === "lfs") {
    return STOCK_GIT_LFS_FILTER.get(parts.variable)?.(value) ?? false;
  }
  return KEYS_WITH_ANY_SUBSECTION.get(name)?.(value) ?? false;
}

function unreadableFromResult(
  result: SubprocessResult,
  command: string,
): UnreadableGitConfigError | null {
  if (result.code !== 0) {
    return new UnreadableGitConfigError(
      "git-failed",
      describeSubprocessFailure(result, command),
    );
  }
  if (result.stdout.endsWith(TRUNCATION_MARKER)) {
    return new UnreadableGitConfigError(
      "truncated",
      `${command} output exceeded the capture limit`,
    );
  }
  return null;
}

function splitNulRecords(stdout: string, command: string): string[] {
  if (stdout === "") {
    return [];
  }
  if (!stdout.endsWith("\0")) {
    throw new UnreadableGitConfigError(
      "malformed",
      `${command} output does not end with a record terminator`,
    );
  }
  return stdout.slice(0, -1).split("\0");
}

function parseConfigListing(
  result: SubprocessResult,
  source: string,
  owner: Repository,
): ConfigRecord[] {
  const command = `git config (${source})`;
  const failure = unreadableFromResult(result, command);
  if (failure !== null) {
    throw failure;
  }
  const rawRecords = splitNulRecords(result.stdout, command);
  if (rawRecords.length > MAX_KEYS_PER_CONFIG_FILE) {
    throw new UnreadableGitConfigError(
      "cap-reached",
      `${source} has more than ${MAX_KEYS_PER_CONFIG_FILE} keys`,
    );
  }
  return rawRecords.map((rawRecord) => {
    const separator = rawRecord.indexOf("\n");
    const key = separator < 0 ? rawRecord : rawRecord.slice(0, separator);
    if (key === "") {
      throw new UnreadableGitConfigError(
        "malformed",
        `${command} printed a record without a key`,
      );
    }
    return {
      source,
      key,
      value: separator < 0 ? null : rawRecord.slice(separator + 1),
      owner,
    };
  });
}

function sourceLabel(walk: Walk, path: string, suffix = ""): string {
  return `${relative(walk.repoRoot, path) || basename(path)}${suffix}`;
}

function runGitOutsideRepositories(
  walk: Walk,
  args: string[],
): Promise<SubprocessResult> {
  return runRealSubprocess("git", [...HARDENED_GIT_ARGS, ...args], {
    cwd: walk.neutralDirectory,
    timeoutMs: GIT_LISTING_TIMEOUT_MS,
    env: {
      ...GIT_TRANSPORTS_DISABLED,
      GIT_CEILING_DIRECTORIES: walk.neutralDirectory,
    },
    unsetEnv: REPOSITORY_LOCAL_GIT_VARIABLES,
  });
}

async function listConfigFile(
  walk: Walk,
  path: string,
  owner: Repository,
): Promise<ConfigRecord[]> {
  const result = await runGitOutsideRepositories(walk, [
    "config",
    "--file",
    path,
    "--null",
    "--list",
  ]);
  return parseConfigListing(result, sourceLabel(walk, path), owner);
}

async function listConfigBlob(
  walk: Walk,
  owner: Repository,
  blob: string,
  label: string,
): Promise<ConfigRecord[]> {
  const result = await runGitOutsideRepositories(walk, [
    `--git-dir=${owner.gitDir}`,
    "config",
    "--blob",
    blob,
    "--null",
    "--list",
  ]);
  return parseConfigListing(result, label, owner);
}

async function regularFileExists(path: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new UnreadableGitConfigError(
      "git-failed",
      `cannot inspect ${path}: ${(error as Error).message}`,
    );
  }
  if (!stats.isFile()) {
    throw new UnreadableGitConfigError(
      "not-a-regular-file",
      `${path} is not a regular file`,
    );
  }
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function revParseRepository(directory: string): Promise<SubprocessResult> {
  return runRepositoryGit(directory, [
    "rev-parse",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
}

async function locateTopLevelRepository(
  directory: string,
): Promise<Repository | null> {
  const result = await revParseRepository(directory);
  const failure = unreadableFromResult(result, "git rev-parse");
  if (failure === null) {
    return repositoryFrom(result, directory, false);
  }
  const gitAnsweredNoRepository =
    isSpawnFailure(result) || result.code === GIT_NOT_A_REPOSITORY;
  if (gitAnsweredNoRepository && !(await hasGitEntry(directory))) {
    return null;
  }
  throw failure;
}

async function locateSubmodule(directory: string): Promise<Repository> {
  const result = await revParseRepository(directory);
  const failure = unreadableFromResult(result, "git rev-parse");
  if (failure !== null) {
    throw failure;
  }
  return repositoryFrom(result, directory, true);
}

async function repositoryFrom(
  result: SubprocessResult,
  directory: string,
  isSubmodule: boolean,
): Promise<Repository> {
  const [topLevel, gitDir, commonDir] = result.stdout.trim().split("\n");
  if (!topLevel || !gitDir || !commonDir) {
    throw new UnreadableGitConfigError(
      "malformed",
      "git rev-parse did not print the work tree and git directories",
    );
  }
  if (!(await sameDirectory(topLevel, directory))) {
    throw new UnreadableGitConfigError(
      "git-failed",
      `git treats ${directory} as part of the repository at ${topLevel}`,
    );
  }
  return {
    worktree: directory,
    gitDir: resolve(directory, gitDir),
    commonDir: resolve(directory, commonDir),
    isSubmodule,
  };
}

async function listIndex(worktree: string): Promise<IndexEntry[]> {
  const result = await runRepositoryGit(worktree, [
    "ls-files",
    "--sparse",
    "-s",
    "-z",
  ]);
  const failure = unreadableFromResult(result, "git ls-files");
  if (failure !== null) {
    throw failure;
  }
  return splitNulRecords(result.stdout, "git ls-files").map((rawEntry) => {
    const match = /^(\d{6}) [0-9a-f]+ (\d)\t(.+)$/s.exec(rawEntry);
    if (match === null) {
      throw new UnreadableGitConfigError(
        "malformed",
        "git ls-files printed an entry agemon cannot read",
      );
    }
    if (match[1] === SPARSE_DIRECTORY_MODE) {
      throw new UnreadableGitConfigError(
        "malformed",
        "the index is sparse, so its gitlinks cannot be listed without expanding it",
      );
    }
    return { mode: match[1], stage: match[2], path: match[3] };
  });
}

async function readCommittedGitmodules(
  walk: Walk,
  owner: Repository,
  label: string,
): Promise<ConfigRecord[]> {
  const head = await runRepositoryGit(owner.worktree, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);
  if (head.code === REV_PARSE_NO_SUCH_REVISION && !isSpawnFailure(head)) {
    return [];
  }
  const headFailure = unreadableFromResult(head, "git rev-parse HEAD");
  if (headFailure !== null) {
    throw headFailure;
  }
  const tree = await runRepositoryGit(owner.worktree, [
    "ls-tree",
    "-z",
    "HEAD",
    "--",
    ".gitmodules",
  ]);
  const treeFailure = unreadableFromResult(tree, "git ls-tree");
  if (treeFailure !== null) {
    throw treeFailure;
  }
  const entries = splitNulRecords(tree.stdout, "git ls-tree");
  if (entries.length === 0) {
    return [];
  }
  if (
    entries.length !== 1 ||
    !entries[0].startsWith(`${REGULAR_BLOB_MODE} blob `)
  ) {
    throw new UnreadableGitConfigError(
      "not-a-regular-file",
      `${label} in HEAD is not a regular file`,
    );
  }
  return listConfigBlob(walk, owner, "HEAD:.gitmodules", `${label} (HEAD)`);
}

async function readGitmodules(
  walk: Walk,
  owner: Repository,
  index: IndexEntry[],
): Promise<ConfigRecord[]> {
  const worktreeFile = join(owner.worktree, ".gitmodules");
  if (await regularFileExists(worktreeFile)) {
    return listConfigFile(walk, worktreeFile, owner);
  }
  const label = sourceLabel(walk, worktreeFile);
  const indexEntry = index.find(
    (entry) =>
      entry.path === ".gitmodules" && entry.stage === UNMERGED_STAGE_NONE,
  );
  if (indexEntry === undefined) {
    return readCommittedGitmodules(walk, owner, label);
  }
  if (indexEntry.mode !== REGULAR_BLOB_MODE) {
    throw new UnreadableGitConfigError(
      "not-a-regular-file",
      `${label} in the index is not a regular file`,
    );
  }
  return listConfigBlob(walk, owner, ":.gitmodules", `${label} (index)`);
}

async function collectRecords(
  walk: Walk,
  repository: Repository,
  depth: number,
): Promise<ConfigRecord[]> {
  const configFiles = [
    ...new Set([
      join(repository.commonDir, "config"),
      join(repository.gitDir, "config.worktree"),
      join(repository.commonDir, "config.worktree"),
    ]),
  ];
  const records: ConfigRecord[] = [];
  for (const configFile of configFiles) {
    if (await regularFileExists(configFile)) {
      records.push(...(await listConfigFile(walk, configFile, repository)));
    }
  }
  const index = await listIndex(repository.worktree);
  records.push(...(await readGitmodules(walk, repository, index)));

  const gitlinks = index.filter(
    (entry) =>
      entry.mode === GITLINK_MODE && entry.stage === UNMERGED_STAGE_NONE,
  );
  for (const gitlink of gitlinks) {
    walk.submodulesSeen += 1;
    if (walk.submodulesSeen > MAX_SUBMODULES) {
      throw new UnreadableGitConfigError(
        "cap-reached",
        `more than ${MAX_SUBMODULES} submodules`,
      );
    }
    if (gitlink.path.includes(REPLACEMENT_CHARACTER)) {
      throw new UnreadableGitConfigError(
        "malformed",
        "a submodule path is not valid UTF-8",
      );
    }
    const submoduleWorktree = join(repository.worktree, gitlink.path);
    if (!(await pathExists(join(submoduleWorktree, ".git")))) {
      continue;
    }
    if (depth + 1 > MAX_SUBMODULE_DEPTH) {
      throw new UnreadableGitConfigError(
        "cap-reached",
        `submodules nested deeper than ${MAX_SUBMODULE_DEPTH} levels`,
      );
    }
    const submodule = await locateSubmodule(submoduleWorktree);
    records.push(...(await collectRecords(walk, submodule, depth + 1)));
  }
  return records;
}

function canonicalCredentialName(key: string): string | null {
  const parts = splitKey(key);
  return parts === null ? null : `${parts.section}.${parts.variable}`;
}

function displayedRecord(
  record: ConfigRecord,
  shown: (part: string) => string = (part) => part,
): string {
  const firstDot = record.key.indexOf(".");
  const lastDot = record.key.lastIndexOf(".");
  const key =
    firstDot === lastDot
      ? record.key
      : `${record.key.slice(0, firstDot + 1)}${shown(record.key.slice(firstDot + 1, lastDot))}${record.key.slice(lastDot)}`;
  return record.value === null ? key : `${key}=${shown(record.value)}`;
}

function redactedDisplay(record: ConfigRecord): string {
  return printable(displayedRecord(record, redactSecretsInText));
}

function namesIncludedFile(record: ConfigRecord): boolean {
  const section = splitKey(record.key)?.section;
  return section === "include" || section === "includeif";
}

function isShowable(record: ConfigRecord): boolean {
  const value = record.value ?? "";
  if (
    namesIncludedFile(record) ||
    record.key.length > MAX_GIT_CONFIG_KEY_CHARACTERS ||
    value.length > MAX_GIT_CONFIG_VALUE_CHARACTERS ||
    !isSafeIdentifier(record.key) ||
    !isSafeIdentifier(value) ||
    `${record.key}${value}`.includes(REPLACEMENT_CHARACTER)
  ) {
    return false;
  }
  const credentialName = canonicalCredentialName(record.key);
  return (
    redactedDisplay(record) === displayedRecord(record) ||
    (credentialName !== null && CREDENTIAL_CARRYING_KEYS.has(credentialName))
  );
}

function shortSource(source: string): string {
  const shortened = source.split("/").slice(-2).join("/");
  return shortened.length > MAX_GIT_CONFIG_SOURCE_CHARACTERS
    ? `…${shortened.slice(-(MAX_GIT_CONFIG_SOURCE_CHARACTERS - 1))}`
    : shortened;
}

function fingerprintRecords(records: ConfigRecord[]): string {
  return sha256Hex(
    records
      .map(
        (record) =>
          `${record.source}\0${record.key}\0${record.value === null ? "-" : `=${record.value}`}\0`,
      )
      .join(""),
  );
}

async function classify(
  records: ConfigRecord[],
): Promise<GitConfigGuardResult> {
  const outside: ConfigRecord[] = [];
  for (const record of records) {
    if (!(await isAllowlisted(record))) {
      outside.push(record);
    }
  }
  if (outside.length === 0) {
    return CLEAN_GIT_CONFIG;
  }
  const fingerprint = fingerprintRecords(outside);
  if (!outside.every(isShowable)) {
    return { kind: "unshowable", fingerprint };
  }
  if (outside.length > MAX_UNTRUSTED_GIT_CONFIG_PAIRS) {
    return { kind: "tooMany", count: outside.length, fingerprint };
  }
  const pairs = outside.map(
    (record) => `${shortSource(record.source)}: ${redactedDisplay(record)}`,
  );
  if (
    pairs.some((pair) => pair.length > MAX_UNTRUSTED_GIT_CONFIG_PAIR_CHARACTERS)
  ) {
    return { kind: "unshowable", fingerprint };
  }
  return { kind: "pairs", pairs, fingerprint };
}

export async function findUntrustedGitConfig(
  repoRoot: string,
): Promise<GitConfigGuardResult> {
  const neutralDirectory = await mkdtemp(join(tmpdir(), "agemon-git-config-"));
  try {
    const repository = await locateTopLevelRepository(repoRoot);
    if (repository === null) {
      return CLEAN_GIT_CONFIG;
    }
    const walk: Walk = { repoRoot, neutralDirectory, submodulesSeen: 0 };
    return await classify(await collectRecords(walk, repository, 0));
  } catch (error) {
    if (error instanceof UnreadableGitConfigError) {
      return {
        kind: "unreadable",
        category: error.category,
        detail: printable(error.message),
      };
    }
    throw error;
  } finally {
    await rm(neutralDirectory, { recursive: true, force: true });
  }
}

export function createGitConfigGuard(repoRoot: string): GitConfigGuard {
  let planned: Promise<GitConfigGuardResult> | undefined;
  return {
    planned() {
      planned ??= findUntrustedGitConfig(repoRoot);
      return planned;
    },
    recheck: () => findUntrustedGitConfig(repoRoot),
  };
}
