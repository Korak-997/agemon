import { join } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import {
  RefusedFileError,
  readRegularFileIfExists,
  writeFileAtomic,
} from "./files.js";
import { printable } from "./untrusted-text.js";

const CONFIG_FILE_NAME = "agemon.toml";
const CONFIG_KEYS: readonly string[] = [
  "capabilities",
  "skill_groups",
  "conflict_decisions",
];

export type ConflictDecision = "keep" | "replace" | "skip";

export interface AgemonConfig {
  capabilities: string[];
  skillGroups: string | null;
  conflictDecisions: Record<string, ConflictDecision>;
}

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
    conflictDecisions: validateConflictDecisions(record.conflict_decisions),
  };
}

export async function writeConfig(
  cwd: string,
  config: AgemonConfig,
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
