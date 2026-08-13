import { readFile, writeFile } from "node:fs/promises";
import { type MergeValue, mergeValues } from "./deep-merge.js";

type JsonObject = { [key: string]: MergeValue };

function assertJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object at the document root.");
  }

  return value as JsonObject;
}

function parseJsonObject(content: string): JsonObject {
  if (content.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(content) as unknown;
  return assertJsonObject(parsed);
}

export function mergeJsonObject(
  content: string,
  patch: JsonObject,
): { nextContent: string; changed: boolean } {
  const current = parseJsonObject(content);
  const merged = mergeValues(current, patch) as JsonObject;

  const normalizedCurrent = `${JSON.stringify(current, null, 2)}\n`;
  const nextContent = `${JSON.stringify(merged, null, 2)}\n`;
  return {
    nextContent,
    changed: nextContent !== normalizedCurrent,
  };
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function mergeJsonObjectFile(
  filePath: string,
  patch: JsonObject,
): Promise<boolean> {
  const content = await readFileOrEmpty(filePath);
  const merged = mergeJsonObject(content, patch);
  if (!merged.changed) {
    return false;
  }

  await writeFile(filePath, merged.nextContent, "utf8");
  return true;
}
