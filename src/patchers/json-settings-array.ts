import {
  effectiveMemberIndex,
  endOfContainer,
  endOfValue,
  isPlainObject,
  objectMembers,
  parseSettings,
  removeMember,
  removeSpan,
  replaceRange,
  skipWhitespace,
  type TextSpan,
  whitespaceBefore,
} from "./json-settings-key.js";

const DEFAULT_INDENT_UNIT = "  ";

export type ArrayReading =
  | { kind: "absent" }
  | { kind: "present"; entries: unknown[] }
  | { kind: "invalid"; reason: string };

export type AddArrayEntryResult =
  | { kind: "changed"; nextContent: string }
  | { kind: "unchanged" }
  | { kind: "invalid"; reason: string };

export type RemoveArrayEntryResult =
  | { kind: "removed"; nextContent: string; settingsAreEmpty: boolean }
  | { kind: "unchanged" }
  | { kind: "invalid"; reason: string };

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    isPlainObject(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

function arrayElements(text: string, opening: number): TextSpan[] {
  const elements: TextSpan[] = [];
  let position = skipWhitespace(text, opening + 1);
  while (text[position] !== "]") {
    const end = endOfValue(text, position);
    elements.push({ start: position, end });
    position = skipWhitespace(text, end);
    if (text[position] === ",") {
      position = skipWhitespace(text, position + 1);
    }
  }
  return elements;
}

function memberSpans(text: string, opening: number): TextSpan[] {
  return objectMembers(text, opening).map((member) => ({
    start: member.keyStart,
    end: member.valueEnd,
  }));
}

function indentUnitOf(text: string, root: number): string {
  const [firstMember] = objectMembers(text, root);
  const gap = whitespaceBefore(text, firstMember.keyStart);
  return gap.includes("\n")
    ? gap.slice(gap.lastIndexOf("\n") + 1)
    : DEFAULT_INDENT_UNIT;
}

function renderAtGap(value: unknown, gap: string, unit: string): string {
  return gap.includes("\n")
    ? JSON.stringify(value, null, unit).replaceAll("\n", gap)
    : JSON.stringify(value);
}

function nestUnder(keys: readonly string[], entry: unknown): unknown {
  return keys.reduceRight<unknown>((value, key) => ({ [key]: value }), [entry]);
}

function insertLast(
  text: string,
  opening: number,
  siblings: TextSpan[],
  containerGap: string,
  unit: string,
  renderItem: (gap: string) => string,
): string {
  const last = siblings.at(-1);
  if (last !== undefined) {
    const gap = whitespaceBefore(text, last.start);
    return replaceRange(text, last.end, last.end, `,${gap}${renderItem(gap)}`);
  }
  const multiline = containerGap.includes("\n");
  const gap = multiline ? `${containerGap}${unit}` : "";
  const closing = multiline ? containerGap : "";
  return replaceRange(
    text,
    opening + 1,
    endOfContainer(text, opening) - 1,
    `${gap}${renderItem(gap)}${closing}`,
  );
}

function insertEntry(
  text: string,
  path: readonly string[],
  entry: unknown,
): string {
  const root = skipWhitespace(text, 0);
  if (objectMembers(text, root).length === 0) {
    const filled = renderAtGap(
      nestUnder(path, entry),
      "\n",
      DEFAULT_INDENT_UNIT,
    );
    return replaceRange(text, root, endOfContainer(text, root), filled);
  }
  const unit = indentUnitOf(text, root);
  let opening = root;
  let containerGap = "\n";
  for (const [depth, key] of path.entries()) {
    const members = objectMembers(text, opening);
    const member = members[effectiveMemberIndex(members, key)];
    if (member === undefined) {
      const value = nestUnder(path.slice(depth + 1), entry);
      return insertLast(
        text,
        opening,
        memberSpans(text, opening),
        containerGap,
        unit,
        (gap) => `${JSON.stringify(key)}: ${renderAtGap(value, gap, unit)}`,
      );
    }
    containerGap = whitespaceBefore(text, member.keyStart);
    opening = member.valueStart;
  }
  return insertLast(
    text,
    opening,
    arrayElements(text, opening),
    containerGap,
    unit,
    (gap) => renderAtGap(entry, gap, unit),
  );
}

function deleteEntry(
  text: string,
  path: readonly string[],
  index: number,
): string {
  const openings = [skipWhitespace(text, 0)];
  for (const key of path) {
    const members = objectMembers(text, openings[openings.length - 1]);
    openings.push(members[effectiveMemberIndex(members, key)].valueStart);
  }
  const arrayOpening = openings[path.length];
  const elements = arrayElements(text, arrayOpening);
  if (elements.length > 1) {
    return removeSpan(text, arrayOpening, elements, index);
  }
  let depth = path.length - 1;
  while (depth > 0 && objectMembers(text, openings[depth]).length === 1) {
    depth -= 1;
  }
  return removeMember(text, openings[depth], path[depth]);
}

export function readArrayEntries(
  content: string | null,
  path: readonly string[],
): ArrayReading {
  if (content === null) {
    return { kind: "absent" };
  }
  const parsed = parseSettings(content);
  if (parsed.kind === "invalid") {
    return parsed;
  }
  let container = parsed.settings;
  for (const [depth, key] of path.entries()) {
    if (!Object.hasOwn(container, key)) {
      return { kind: "absent" };
    }
    const value = container[key];
    const label = path.slice(0, depth + 1).join(".");
    if (depth === path.length - 1) {
      return Array.isArray(value)
        ? { kind: "present", entries: value }
        : { kind: "invalid", reason: `its "${label}" is not a JSON array` };
    }
    if (!isPlainObject(value)) {
      return { kind: "invalid", reason: `its "${label}" is not a JSON object` };
    }
    container = value;
  }
  return { kind: "absent" };
}

export function addArrayEntry(
  content: string | null,
  path: readonly string[],
  entry: unknown,
): AddArrayEntryResult {
  const reading = readArrayEntries(content, path);
  if (reading.kind === "invalid") {
    return reading;
  }
  const wanted = canonicalJson(entry);
  if (
    reading.kind === "present" &&
    reading.entries.some((existing) => canonicalJson(existing) === wanted)
  ) {
    return { kind: "unchanged" };
  }
  return {
    kind: "changed",
    nextContent: insertEntry(content ?? "{}\n", path, entry),
  };
}

export function removeArrayEntry(
  content: string,
  path: readonly string[],
  entry: unknown,
): RemoveArrayEntryResult {
  const reading = readArrayEntries(content, path);
  if (reading.kind !== "present") {
    return reading.kind === "invalid" ? reading : { kind: "unchanged" };
  }
  const wanted = canonicalJson(entry);
  const index = reading.entries.findIndex(
    (existing) => canonicalJson(existing) === wanted,
  );
  if (index === -1) {
    return { kind: "unchanged" };
  }
  const nextContent = deleteEntry(content, path, index);
  return {
    kind: "removed",
    nextContent,
    settingsAreEmpty: Object.keys(JSON.parse(nextContent)).length === 0,
  };
}
