import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { type MergeValue, mergeValues } from "./deep-merge.js";

type FrontmatterObject = { [key: string]: MergeValue };

function assertFrontmatterObject(value: unknown): FrontmatterObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected YAML frontmatter to parse into an object.");
  }

  return value as FrontmatterObject;
}

function splitFrontmatter(
  content: string,
): { frontmatter: string; body: string } | { frontmatter: null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (match?.index !== 0) {
    return { frontmatter: null, body: content };
  }

  const matched = match[0];
  return { frontmatter: match[1], body: content.slice(matched.length) };
}

function renderFrontmatter(frontmatter: FrontmatterObject): string {
  const yaml = stringify(frontmatter, { lineWidth: 0 });
  const normalizedYaml = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  return `---\n${normalizedYaml}---\n`;
}

export function mergeYamlFrontmatter(
  content: string,
  patch: FrontmatterObject,
): { nextContent: string; changed: boolean } {
  const parts = splitFrontmatter(content);

  const currentObject: FrontmatterObject =
    parts.frontmatter === null
      ? {}
      : assertFrontmatterObject(parse(parts.frontmatter) as unknown);

  const mergedObject = mergeValues(currentObject, patch) as FrontmatterObject;
  const rendered = renderFrontmatter(mergedObject);
  const nextContent = `${rendered}${parts.body}`;

  const currentRendered = `${renderFrontmatter(currentObject)}${parts.body}`;
  if (parts.frontmatter === null) {
    return { nextContent, changed: true };
  }

  return {
    nextContent,
    changed: nextContent !== currentRendered,
  };
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function mergeYamlFrontmatterFile(
  filePath: string,
  patch: FrontmatterObject,
): Promise<boolean> {
  const content = await readFileOrEmpty(filePath);
  const merged = mergeYamlFrontmatter(content, patch);
  if (!merged.changed) {
    return false;
  }

  await writeFile(filePath, merged.nextContent, "utf8");
  return true;
}
