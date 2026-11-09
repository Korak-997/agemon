import { skillFrontmatter } from "./skill-manifest.js";

const AGENT_SKILLS_STANDARD_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const METADATA_KEY = "metadata";
const DEFAULT_METADATA_INDENT = "  ";
const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z0-9_-]+):(.*)$/u;
const METADATA_CHILD_PATTERN = /^(\s+)([A-Za-z0-9_-]+):/u;
const COMMENT_OR_BLANK_PATTERN = /^\s*(#.*)?$/u;
const LEADING_WHITESPACE_PATTERN = /^\s*/u;
const COLUMN_ZERO_LIST_ITEM_PATTERN = /^- /u;
const SURROUNDING_QUOTES_PATTERN = /^(["'])(.*)\1$/u;
const EXPLICIT_ONLY_PATTERN = /^["']?disable-model-invocation["']?:(.*)$/mu;
const INLINE_COMMENT_PATTERN = /\s+#.*$/u;
const QUOTES_PATTERN = /["']/gu;

interface FrontmatterField {
  key: string;
  lines: string[];
}

function parseFields(frontmatter: string): FrontmatterField[] | null {
  const fields: FrontmatterField[] = [];
  for (const line of frontmatter.split(/\r?\n/u)) {
    const key = TOP_LEVEL_KEY_PATTERN.exec(line)?.[1];
    if (key !== undefined) {
      fields.push({ key, lines: [line] });
    } else if (
      line.startsWith(" ") ||
      line.startsWith("\t") ||
      COLUMN_ZERO_LIST_ITEM_PATTERN.test(line) ||
      COMMENT_OR_BLANK_PATTERN.test(line)
    ) {
      fields.at(-1)?.lines.push(line);
    } else {
      return null;
    }
  }
  return fields;
}

function fieldValueAsString({ key, lines }: FrontmatterField): string {
  const [firstLine, ...continuation] = lines;
  const value = [
    firstLine.slice(key.length + 1).trim(),
    ...continuation.map((line) => line.trim()),
  ]
    .filter((line) => line !== "")
    .join("\n");
  return SURROUNDING_QUOTES_PATTERN.exec(value)?.[2] ?? value;
}

function indentOf(line: string): string {
  return LEADING_WHITESPACE_PATTERN.exec(line)?.[0] ?? "";
}

function mergeIntoMetadata(
  metadata: FrontmatterField,
  moved: FrontmatterField[],
): boolean {
  if (metadata.lines[0].trim() !== `${METADATA_KEY}:`) {
    return false;
  }
  const childLines = metadata.lines
    .slice(1)
    .filter((line) => !COMMENT_OR_BLANK_PATTERN.test(line));
  const indent =
    childLines.length > 0 ? indentOf(childLines[0]) : DEFAULT_METADATA_INDENT;
  const childNames: string[] = [];
  for (const line of childLines) {
    const child = METADATA_CHILD_PATTERN.exec(line);
    if (child?.[1] === indent) {
      childNames.push(child[2]);
    } else if (indentOf(line).length <= indent.length) {
      return false;
    }
  }
  if (moved.some(({ key }) => childNames.includes(key))) {
    return false;
  }
  metadata.lines.push(
    ...moved.map(
      (field) =>
        `${indent}${field.key}: ${JSON.stringify(fieldValueAsString(field))}`,
    ),
  );
  return true;
}

/**
 * Moves keys the Agent Skills standard does not define into `metadata`, as
 * strings, because other agents validate frontmatter or give those names their
 * own meaning: Codex's validator rejects them, and Devin reads `triggers` as
 * `user` / `model`. Returns null when `metadata` cannot take them safely.
 */
export function portableSkillManifest(manifest: string): string | null {
  const frontmatter = skillFrontmatter(manifest);
  if (frontmatter === undefined) {
    return manifest;
  }
  const fields = parseFields(frontmatter);
  if (fields === null) {
    return null;
  }
  const moved = fields.filter(
    ({ key }) => !AGENT_SKILLS_STANDARD_KEYS.has(key),
  );
  if (moved.length === 0) {
    return manifest;
  }
  const kept = fields.filter(({ key }) => AGENT_SKILLS_STANDARD_KEYS.has(key));
  const existingMetadata = kept.find(({ key }) => key === METADATA_KEY);
  const metadata = existingMetadata ?? {
    key: METADATA_KEY,
    lines: [`${METADATA_KEY}:`],
  };
  if (!mergeIntoMetadata(metadata, moved)) {
    return null;
  }
  const portable = [...kept, ...(existingMetadata ? [] : [metadata])]
    .flatMap(({ lines }) => lines)
    .join("\n");
  return manifest.replace(frontmatter, () => portable);
}

export function invokedOnlyByName(manifest: string): boolean {
  const value = EXPLICIT_ONLY_PATTERN.exec(
    skillFrontmatter(manifest) ?? "",
  )?.[1];
  return (
    value !== undefined &&
    value
      .replace(INLINE_COMMENT_PATTERN, "")
      .replace(QUOTES_PATTERN, "")
      .trim()
      .toLowerCase() !== "false"
  );
}
