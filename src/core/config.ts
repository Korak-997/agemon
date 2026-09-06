import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";

const CONFIG_FILE_NAME = "agemon.toml";

export type ConflictDecision = "keep-mine" | "skip";

export interface AgemonConfig {
  capabilities: string[];
  skillGroups: string | null;
  conflictDecisions: Record<string, ConflictDecision>;
}

export function resolveConfigPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

function fail(detail: string): never {
  throw new Error(`${CONFIG_FILE_NAME} is invalid: ${detail}`);
}

function validateCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail("'capabilities' must be an array of capability ids");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail("'capabilities' entries must be non-empty strings");
    }
    return entry;
  });
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
    if (decision !== "keep-mine" && decision !== "skip") {
      fail(
        `'conflict_decisions.${resourceId}' must be "keep-mine" or "skip", got ${JSON.stringify(decision)}`,
      );
    }
    decisions[resourceId] = decision;
  }
  return decisions;
}

export async function loadConfig(cwd: string): Promise<AgemonConfig | null> {
  let rawContents: string;
  try {
    rawContents = await readFile(resolveConfigPath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Unable to read ${CONFIG_FILE_NAME}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(rawContents);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message : String(error);
    fail(`not valid TOML — ${detail}`);
  }

  const record = parsed as Record<string, unknown>;
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

  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${stringify(payload)}\n`, "utf8");
  await rename(tempPath, configPath);
  return configPath;
}
