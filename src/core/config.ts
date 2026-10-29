import { join } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import {
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const CONFIG_FILE_NAME = "agemon.toml";
const CONFIG_KEYS: readonly string[] = [
  "capabilities",
  "skill_groups",
  "custom_skill_groups",
  "conflict_decisions",
];

const CUSTOM_GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const RESERVED_GROUP_IDS: readonly string[] = ["all", "none"];
const MAX_CUSTOM_GROUP_LABEL_CHARACTERS = 80;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const LOCAL_SOURCE_PATTERN = /^\.\/(?:[A-Za-z0-9._-]+\/)*([A-Za-z0-9._-]+)$/u;
const AGENT_DIRECTORIES: readonly string[] = [".agents", ".claude"];
const GITHUB_SOURCE_PATTERN =
  /^github:([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/u;
const COMMIT_REF_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_CUSTOM_GROUPS = 20;
const MAX_SKILLS_PER_CUSTOM_GROUP = 50;
const MAX_REMOTE_REPOSITORIES = 10;

export type ConflictDecision = "keep" | "replace" | "skip";

export type CustomSkillSource =
  | { kind: "local"; path: string; skillName: string }
  | {
      kind: "github";
      owner: string;
      repository: string;
      ref: string;
      skillName: string;
    };

export interface CustomSkillGroupConfig {
  id: string;
  label: string;
  skills: CustomSkillSource[];
}

export interface AgemonConfig {
  capabilities: string[];
  skillGroups: string | null;
  customSkillGroups: CustomSkillGroupConfig[];
  conflictDecisions: Record<string, ConflictDecision>;
}

export type PersistedConfig = Omit<AgemonConfig, "customSkillGroups">;

export function resolveConfigPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

function fail(detail: string): never {
  throw new Error(`${CONFIG_FILE_NAME} is invalid: ${printable(detail)}`);
}

function validateCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail("'capabilities' must be an array of capability ids");
  }
  if (value.length === 0) {
    fail("'capabilities' must list at least one capability id");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail("'capabilities' entries must be non-empty strings");
    }
    return entry;
  });
}

function validateKnownKeys(record: Record<string, unknown>): void {
  const unknownKey = Object.keys(record).find(
    (key) => !CONFIG_KEYS.includes(key),
  );
  if (unknownKey !== undefined) {
    fail(`unknown key '${unknownKey}'. Valid keys: ${CONFIG_KEYS.join(", ")}.`);
  }
}

function validateSkillGroups(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    fail("'skill_groups' must be a string when present");
  }
  return value;
}

function asTable(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`'${field}' must be a table`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  table: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const unknownKey = Object.keys(table).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKey !== undefined) {
    fail(
      `'${field}' has unknown key '${unknownKey}'. Valid keys: ${allowedKeys.join(", ")}.`,
    );
  }
}

export function isPlainSkillName(value: string): boolean {
  return SKILL_NAME_PATTERN.test(value);
}

function validateSkillName(value: unknown, field: string): string {
  if (typeof value !== "string" || !isPlainSkillName(value)) {
    fail(
      `'${field}' must be a skill name of lower-case letters, digits, '.', '_' or '-' (at most 64 characters, not starting with '-' or '.')`,
    );
  }
  return value;
}

function validateLocalSource(path: string, field: string): CustomSkillSource {
  const match = LOCAL_SOURCE_PATTERN.exec(path);
  const components = path.split("/").slice(1);
  if (
    match === null ||
    components.some((component) => component === "." || component === "..")
  ) {
    fail(
      `'${field}' must be a repository-relative path like "./tools/skills/<name>" without '.' or '..' components`,
    );
  }
  if (AGENT_DIRECTORIES.includes(components[0].toLowerCase())) {
    fail(
      `'${field}' must not point into ${AGENT_DIRECTORIES.join(" or ")}, where installed skills live`,
    );
  }
  return {
    kind: "local",
    path,
    skillName: validateSkillName(match[1], `${field} (last path component)`),
  };
}

function validateCustomSkill(value: unknown, field: string): CustomSkillSource {
  const skill = asTable(value, field);
  if (typeof skill.source !== "string") {
    fail(`'${field}.source' must be a string`);
  }
  if (!skill.source.startsWith("github:")) {
    assertOnlyKeys(skill, ["source"], field);
    return validateLocalSource(skill.source, `${field}.source`);
  }

  assertOnlyKeys(skill, ["source", "ref", "skill"], field);
  const match = GITHUB_SOURCE_PATTERN.exec(skill.source);
  if (match === null) {
    fail(`'${field}.source' must be "github:<owner>/<repository>"`);
  }
  if (typeof skill.ref !== "string" || !COMMIT_REF_PATTERN.test(skill.ref)) {
    fail(
      `'${field}.ref' must be a full 40-character commit sha; branches, tags and short shas are refused`,
    );
  }
  return {
    kind: "github",
    owner: match[1],
    repository: match[2],
    ref: skill.ref,
    skillName: validateSkillName(skill.skill, `${field}.skill`),
  };
}

function validateCustomSkillGroup(
  id: string,
  value: unknown,
): CustomSkillGroupConfig {
  const field = `custom_skill_groups.${id}`;
  if (!CUSTOM_GROUP_ID_PATTERN.test(id) || RESERVED_GROUP_IDS.includes(id)) {
    fail(
      `'${field}': a group id is lower-case letters, digits and '-' (at most 40 characters), and not ${RESERVED_GROUP_IDS.join(" or ")}`,
    );
  }
  const group = asTable(value, field);
  assertOnlyKeys(group, ["label", "skills"], field);
  if (
    typeof group.label !== "string" ||
    group.label.trim().length === 0 ||
    group.label.length > MAX_CUSTOM_GROUP_LABEL_CHARACTERS ||
    !isSafeIdentifier(group.label)
  ) {
    fail(
      `'${field}.label' must be a non-empty single-line string of at most ${MAX_CUSTOM_GROUP_LABEL_CHARACTERS} characters, without invisible or control characters`,
    );
  }
  if (
    !Array.isArray(group.skills) ||
    group.skills.length === 0 ||
    group.skills.length > MAX_SKILLS_PER_CUSTOM_GROUP
  ) {
    fail(
      `'${field}.skills' must list between 1 and ${MAX_SKILLS_PER_CUSTOM_GROUP} skills`,
    );
  }
  return {
    id,
    label: group.label,
    skills: group.skills.map((skill: unknown, index: number) =>
      validateCustomSkill(skill, `${field}.skills[${index}]`),
    ),
  };
}

function validateCustomSkillGroups(value: unknown): CustomSkillGroupConfig[] {
  if (value === undefined) {
    return [];
  }
  const groups = Object.entries(asTable(value, "custom_skill_groups")).map(
    ([id, group]) => validateCustomSkillGroup(id, group),
  );
  if (groups.length > MAX_CUSTOM_GROUPS) {
    fail(
      `'custom_skill_groups' may define at most ${MAX_CUSTOM_GROUPS} groups`,
    );
  }

  const skillNames = groups.flatMap((group) =>
    group.skills.map((skill) => skill.skillName),
  );
  const duplicateName = skillNames.find(
    (name, index) => skillNames.indexOf(name) !== index,
  );
  if (duplicateName !== undefined) {
    fail(
      `skill '${duplicateName}' appears more than once in 'custom_skill_groups'`,
    );
  }

  const remoteRepositories = new Set(
    groups.flatMap((group) =>
      group.skills.flatMap((skill) =>
        skill.kind === "github" ? [`${skill.owner}/${skill.repository}`] : [],
      ),
    ),
  );
  if (remoteRepositories.size > MAX_REMOTE_REPOSITORIES) {
    fail(
      `'custom_skill_groups' may use at most ${MAX_REMOTE_REPOSITORIES} GitHub repositories`,
    );
  }
  return groups;
}

function validateConflictDecisions(
  value: unknown,
): Record<string, ConflictDecision> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("'conflict_decisions' must be a table of resource id to decision");
  }
  const decisions: Record<string, ConflictDecision> = {};
  for (const [resourceId, decision] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (decision !== "keep" && decision !== "replace" && decision !== "skip") {
      fail(
        `'conflict_decisions.${resourceId}' must be "keep", "replace", or "skip", got ${JSON.stringify(decision)}`,
      );
    }
    decisions[resourceId] = decision;
  }
  return decisions;
}

export async function loadConfig(cwd: string): Promise<AgemonConfig | null> {
  let rawContents: string | null;
  try {
    rawContents = await readRegularFileIfExists(resolveConfigPath(cwd));
  } catch (error) {
    if (error instanceof RefusedFileError) {
      fail(error.message);
    }
    throw new Error(`Unable to read ${CONFIG_FILE_NAME}: ${String(error)}`);
  }
  if (rawContents === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parse(rawContents);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message : String(error);
    fail(`not valid TOML — ${detail}`);
  }

  const record = parsed as Record<string, unknown>;
  validateKnownKeys(record);
  return {
    capabilities: validateCapabilities(record.capabilities),
    skillGroups: validateSkillGroups(record.skill_groups),
    customSkillGroups: validateCustomSkillGroups(record.custom_skill_groups),
    conflictDecisions: validateConflictDecisions(record.conflict_decisions),
  };
}

export async function writeConfig(
  cwd: string,
  config: PersistedConfig,
): Promise<string> {
  const configPath = resolveConfigPath(cwd);
  const payload: Record<string, unknown> = {
    capabilities: config.capabilities,
  };
  if (config.skillGroups !== null) {
    payload.skill_groups = config.skillGroups;
  }
  payload.conflict_decisions = config.conflictDecisions;

  await writeFileAtomic(configPath, `${stringify(payload)}\n`);
  return configPath;
}
