import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify, TomlError } from "smol-toml";
import { BackupPathOccupiedError, writeBackupOnce } from "./backups.js";
import {
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { sha256Hex } from "./fingerprint.js";
import { isSafeIdentifier, printable } from "./untrusted-text.js";

const CONFIG_FILE_NAME = "agemon.toml";
const CONFIG_BACKUP_RESOURCE_PREFIX = "config:agemon.toml";
const CONFIG_BACKUP_CONTENT_HASH_LENGTH = 16;

const MAX_CUSTOM_GROUP_ID_CHARACTERS = 40;
const CUSTOM_GROUP_ID_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${MAX_CUSTOM_GROUP_ID_CHARACTERS - 1}}$`,
  "u",
);
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

export const CONFLICT_DECISIONS = ["keep", "replace", "skip"] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];

export const SKILL_GROUPS_WHEN_ABSENT =
  "interactive prompt per group, or essentials-only when non-interactive";

export interface ConfigKey {
  name: string;
  type: string;
  whenAbsent: string | null;
  summary: string;
  githubSourceOnly?: true;
}

interface ConfigTable {
  heading: string;
  keys: readonly ConfigKey[];
}

export const AGEMON_TOML_TABLES: Readonly<{
  topLevel: ConfigTable;
  customSkillGroup: ConfigTable;
  customSkill: ConfigTable;
}> = {
  topLevel: {
    heading: "Top-level keys",
    keys: [
      {
        name: "capabilities",
        type: "array of capability ids",
        whenAbsent: null,
        summary:
          "The capabilities agemon reconciles in this repository. An empty list or an unknown id is an error.",
      },
      {
        name: "skill_groups",
        type: "string: comma-separated group ids, or all or none",
        whenAbsent: SKILL_GROUPS_WHEN_ABSENT,
        summary:
          "The skill groups to install, as with --skill-groups; the flag wins when both are given.",
      },
      {
        name: "custom_skill_groups",
        type: "table of group id to custom group table",
        whenAbsent: "no project-defined groups",
        summary: `Project-defined skill groups. A group id is lower-case letters, digits and '-' (at most ${MAX_CUSTOM_GROUP_ID_CHARACTERS} characters), not all or none, and not a built-in group id.`,
      },
      {
        name: "conflict_decisions",
        type: "table of resource id to decision",
        whenAbsent: "every conflict needs a decision in the run",
        summary:
          "What to do with a rule file that holds your own rules where agemon would write a pointer.",
      },
      {
        name: "known_capabilities",
        type: "array of capability ids",
        whenAbsent: "the capabilities agemon had before this key existed",
        summary:
          "The capabilities the agemon that wrote the file knew about, so a capability added in a later release is offered once.",
      },
    ],
  },
  customSkillGroup: {
    heading: "Custom skill group tables",
    keys: [
      {
        name: "label",
        type: `string, one line, at most ${MAX_CUSTOM_GROUP_LABEL_CHARACTERS} characters`,
        whenAbsent: null,
        summary: "The name shown when agemon asks which groups to install.",
      },
      {
        name: "skills",
        type: `array of 1 to ${MAX_SKILLS_PER_CUSTOM_GROUP} skill entries`,
        whenAbsent: null,
        summary: "The skills in the group, each a local or a GitHub source.",
      },
    ],
  },
  customSkill: {
    heading: "Custom skill entries",
    keys: [
      {
        name: "source",
        type: 'string: "./<path>" or "github:<owner>/<repository>"',
        whenAbsent: null,
        summary:
          "A directory in this repository (the skill's name is the directory name), or a GitHub repository.",
      },
      {
        name: "ref",
        type: "string: a full 40-character commit sha",
        whenAbsent: null,
        summary:
          "The commit to fetch; branches, tags and short shas are refused. Only for GitHub sources.",
        githubSourceOnly: true,
      },
      {
        name: "skill",
        type: "string: a skill name",
        whenAbsent: null,
        summary:
          "The skill to take from skills/<skill>/ in the repository. Only for GitHub sources.",
        githubSourceOnly: true,
      },
    ],
  },
};

const keyNames = (keys: readonly ConfigKey[]): readonly string[] =>
  keys.map((key) => key.name);
const TOP_LEVEL_KEYS = keyNames(AGEMON_TOML_TABLES.topLevel.keys);
const CUSTOM_GROUP_KEYS = keyNames(AGEMON_TOML_TABLES.customSkillGroup.keys);
const GITHUB_SKILL_KEYS = keyNames(AGEMON_TOML_TABLES.customSkill.keys);
const LOCAL_SKILL_KEYS = keyNames(
  AGEMON_TOML_TABLES.customSkill.keys.filter((key) => !key.githubSourceOnly),
);

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
  conflictDecisions: ReadonlyMap<string, ConflictDecision>;
  knownCapabilities: string[] | null;
  sourceText: string;
}

export type PersistedConfig = Omit<
  AgemonConfig,
  "customSkillGroups" | "knownCapabilities" | "sourceText"
> & { knownCapabilities: string[] };

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

function validateKnownCapabilities(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail("'known_capabilities' must be an array of non-empty strings");
  }
  return value;
}

function validateKnownKeys(record: Record<string, unknown>): void {
  const unknownKey = Object.keys(record).find(
    (key) => !TOP_LEVEL_KEYS.includes(key),
  );
  if (unknownKey !== undefined) {
    fail(
      `unknown key '${unknownKey}'. Valid keys: ${TOP_LEVEL_KEYS.join(", ")}.`,
    );
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
    assertOnlyKeys(skill, LOCAL_SKILL_KEYS, field);
    return validateLocalSource(skill.source, `${field}.source`);
  }

  assertOnlyKeys(skill, GITHUB_SKILL_KEYS, field);
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
      `'${field}': a group id is lower-case letters, digits and '-' (at most ${MAX_CUSTOM_GROUP_ID_CHARACTERS} characters), and not ${RESERVED_GROUP_IDS.join(" or ")}`,
    );
  }
  const group = asTable(value, field);
  assertOnlyKeys(group, CUSTOM_GROUP_KEYS, field);
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

const quotedDecisions = CONFLICT_DECISIONS.map((decision) =>
  JSON.stringify(decision),
);
const CONFLICT_DECISION_CHOICES = `${quotedDecisions.slice(0, -1).join(", ")}, or ${quotedDecisions.at(-1)}`;

function isConflictDecision(value: unknown): value is ConflictDecision {
  return CONFLICT_DECISIONS.some((decision) => decision === value);
}

function validateConflictDecisions(
  value: unknown,
): Map<string, ConflictDecision> {
  const decisions = new Map<string, ConflictDecision>();
  if (value === undefined) {
    return decisions;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("'conflict_decisions' must be a table of resource id to decision");
  }
  for (const [resourceId, decision] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!isConflictDecision(decision)) {
      fail(
        `'conflict_decisions.${resourceId}' must be ${CONFLICT_DECISION_CHOICES}, got ${JSON.stringify(decision)}`,
      );
    }
    decisions.set(resourceId, decision);
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
  return validateConfigText(rawContents);
}

function parseConfigRecord(text: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof TomlError ? error.message : String(error);
    fail(`not valid TOML — ${detail}`);
  }
}

export function validateConfigText(text: string): AgemonConfig {
  const record = parseConfigRecord(text);
  validateKnownKeys(record);
  return {
    capabilities: validateCapabilities(record.capabilities),
    skillGroups: validateSkillGroups(record.skill_groups),
    customSkillGroups: validateCustomSkillGroups(record.custom_skill_groups),
    conflictDecisions: validateConflictDecisions(record.conflict_decisions),
    knownCapabilities: validateKnownCapabilities(record.known_capabilities),
    sourceText: text,
  };
}

export type ConfigCapabilityUpdate =
  | { kind: "written"; backupPath: string | null }
  | { kind: "not-written"; reason: string };

function serializeConfigRecord(record: Record<string, unknown>): string {
  return `${stringify(record)}\n`;
}

function configBackupResourceId(
  addedCapabilityIds: string[],
  originalText: string,
): string {
  const contentHash = sha256Hex(originalText).slice(
    0,
    CONFIG_BACKUP_CONTENT_HASH_LENGTH,
  );
  return `${CONFIG_BACKUP_RESOURCE_PREFIX}:${addedCapabilityIds.join(",")}:${contentHash}`;
}

export async function rewriteConfigCapabilities(
  cwd: string,
  config: AgemonConfig,
  update: { capabilities: string[]; knownCapabilities: string[] },
): Promise<ConfigCapabilityUpdate> {
  const configPath = resolveConfigPath(cwd);
  const currentText = await readRegularFileIfExists(configPath);
  if (currentText !== config.sourceText) {
    return { kind: "not-written", reason: "it changed during this run" };
  }

  const currentRecord = parseConfigRecord(currentText);
  const nextRecord = {
    ...currentRecord,
    capabilities: update.capabilities,
    known_capabilities: [
      ...new Set([
        ...(config.knownCapabilities ?? []),
        ...update.knownCapabilities,
      ]),
    ],
  };
  const nextText = serializeConfigRecord(nextRecord);
  // smol-toml ≥1.9 parses tables into null-prototype objects; structuredClone
  // gives plain objects, so the comparison sees values only.
  if (
    !isDeepStrictEqual(
      structuredClone(parseConfigRecord(nextText)),
      structuredClone(nextRecord),
    )
  ) {
    return {
      kind: "not-written",
      reason: "rewriting it would change values agemon did not mean to change",
    };
  }
  validateConfigText(nextText);

  const losesCommentsOrLayout =
    serializeConfigRecord(currentRecord) !== currentText;
  let backup: { path: string } | null = null;
  if (losesCommentsOrLayout) {
    const addedIds = update.capabilities.filter(
      (id) => !config.capabilities.includes(id),
    );
    try {
      backup = await writeBackupOnce(
        cwd,
        configBackupResourceId(addedIds, currentText),
        currentText,
      );
    } catch (error) {
      if (!(error instanceof BackupPathOccupiedError)) {
        throw error;
      }
      return {
        kind: "not-written",
        reason: `agemon's backup path ${relative(cwd, error.backupPath)} holds something else; move it aside and run agemon again`,
      };
    }
  }
  await writeFileAtomic(configPath, nextText);
  return {
    kind: "written",
    backupPath: backup === null ? null : relative(cwd, backup.path),
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
  payload.conflict_decisions = Object.fromEntries(config.conflictDecisions);
  payload.known_capabilities = config.knownCapabilities;

  await writeFileAtomic(configPath, `${stringify(payload)}\n`);
  return configPath;
}
