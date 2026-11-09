const ENV_MEMBER = "env";
// File reads decode invalid UTF-8 to this character, so writing the text back
// would silently replace the user's original bytes.
const UTF8_REPLACEMENT_CHARACTER = "\uFFFD";

export type EnvKeyReading =
  | { kind: "absent" }
  | { kind: "set"; value: string }
  | { kind: "invalid"; reason: string };

export type SetEnvKeyResult =
  | { kind: "changed"; nextContent: string }
  | { kind: "unchanged" }
  | { kind: "conflict"; currentValue: string }
  | { kind: "invalid"; reason: string };

export type RemoveEnvKeyResult =
  | { kind: "removed"; nextContent: string; settingsAreEmpty: boolean }
  | { kind: "unchanged" }
  | { kind: "conflict"; currentValue: string }
  | { kind: "invalid"; reason: string };

interface ObjectMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

function skipWhitespace(text: string, index: number): number {
  let position = index;
  while (/\s/u.test(text[position] ?? "")) {
    position += 1;
  }
  return position;
}

function endOfString(text: string, openingQuote: number): number {
  let position = openingQuote + 1;
  while (text[position] !== '"') {
    position += text[position] === "\\" ? 2 : 1;
  }
  return position + 1;
}

function endOfContainer(text: string, opening: number): number {
  let depth = 0;
  let position = opening;
  do {
    const character = text[position];
    if (character === '"') {
      position = endOfString(text, position);
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
    position += 1;
  } while (depth > 0);
  return position;
}

function endOfPrimitive(text: string, start: number): number {
  let position = start;
  while (!/[\s,\]}]/u.test(text[position] ?? ",")) {
    position += 1;
  }
  return position;
}

function endOfValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    return endOfString(text, start);
  }
  return first === "{" || first === "["
    ? endOfContainer(text, start)
    : endOfPrimitive(text, start);
}

// Callers pass text JSON.parse accepted, so this walk trusts its structure.
function objectMembers(text: string, opening: number): ObjectMember[] {
  const members: ObjectMember[] = [];
  let position = skipWhitespace(text, opening + 1);
  while (text[position] !== "}") {
    const keyEnd = endOfString(text, position);
    const colon = skipWhitespace(text, keyEnd);
    const valueStart = skipWhitespace(text, colon + 1);
    const valueEnd = endOfValue(text, valueStart);
    members.push({
      key: JSON.parse(text.slice(position, keyEnd)),
      keyStart: position,
      valueStart,
      valueEnd,
    });
    position = skipWhitespace(text, valueEnd);
    if (text[position] === ",") {
      position = skipWhitespace(text, position + 1);
    }
  }
  return members;
}

function whitespaceBefore(text: string, index: number): string {
  return /\s*$/u.exec(text.slice(0, index))?.[0] ?? "";
}

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function renderPair(key: string, value: string): string {
  return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
}

function renderEnvObject(
  memberGap: string,
  key: string,
  value: string,
): string {
  if (!memberGap.includes("\n")) {
    return `{${renderPair(key, value)}}`;
  }
  const oneIndent = memberGap.slice(memberGap.lastIndexOf("\n") + 1);
  return `{${memberGap}${oneIndent}${renderPair(key, value)}${memberGap}}`;
}

// JSON.parse keeps the last of duplicate keys, so the edits must target that one.
function effectiveMemberIndex(members: ObjectMember[], key: string): number {
  return members.map((member) => member.key).lastIndexOf(key);
}

function insertEnvKey(text: string, key: string, value: string): string {
  const root = skipWhitespace(text, 0);
  const rootMembers = objectMembers(text, root);
  const env = rootMembers[effectiveMemberIndex(rootMembers, ENV_MEMBER)];
  if (env === undefined) {
    const last = rootMembers.at(-1);
    if (last === undefined) {
      const rendered = `{\n  "${ENV_MEMBER}": ${renderEnvObject("\n  ", key, value)}\n}`;
      return replaceRange(text, root, endOfContainer(text, root), rendered);
    }
    const gap = whitespaceBefore(text, last.keyStart);
    const member = `"${ENV_MEMBER}": ${renderEnvObject(gap, key, value)}`;
    return replaceRange(text, last.valueEnd, last.valueEnd, `,${gap}${member}`);
  }

  const lastEnvMember = objectMembers(text, env.valueStart).at(-1);
  if (lastEnvMember === undefined) {
    const gap = whitespaceBefore(text, env.keyStart);
    return replaceRange(
      text,
      env.valueStart,
      env.valueEnd,
      renderEnvObject(gap, key, value),
    );
  }
  const gap = whitespaceBefore(text, lastEnvMember.keyStart);
  return replaceRange(
    text,
    lastEnvMember.valueEnd,
    lastEnvMember.valueEnd,
    `,${gap}${renderPair(key, value)}`,
  );
}

function removeMember(text: string, opening: number, key: string): string {
  const members = objectMembers(text, opening);
  const index = effectiveMemberIndex(members, key);
  const member = members[index];
  const previous = members[index - 1];
  const next = members[index + 1];
  if (next !== undefined) {
    return replaceRange(text, member.keyStart, next.keyStart, "");
  }
  if (previous !== undefined) {
    return replaceRange(text, previous.valueEnd, member.valueEnd, "");
  }
  return replaceRange(text, opening + 1, endOfContainer(text, opening) - 1, "");
}

function deleteEnvKey(text: string, key: string): string {
  const root = skipWhitespace(text, 0);
  const rootMembers = objectMembers(text, root);
  const env = rootMembers[effectiveMemberIndex(rootMembers, ENV_MEMBER)];
  if (env === undefined) {
    return text;
  }
  return objectMembers(text, env.valueStart).length === 1
    ? removeMember(text, root, ENV_MEMBER)
    : removeMember(text, env.valueStart, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readEnvKey(content: string | null, key: string): EnvKeyReading {
  if (content === null) {
    return { kind: "absent" };
  }
  if (content.includes(UTF8_REPLACEMENT_CHARACTER)) {
    return {
      kind: "invalid",
      reason:
        "it is not clean UTF-8, so it could not be written back unchanged",
    };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    return { kind: "invalid", reason: "it is not valid JSON" };
  }
  if (!isPlainObject(settings)) {
    return { kind: "invalid", reason: "its top level is not a JSON object" };
  }
  if (!Object.hasOwn(settings, ENV_MEMBER)) {
    return { kind: "absent" };
  }
  const env = settings[ENV_MEMBER];
  if (!isPlainObject(env)) {
    return { kind: "invalid", reason: 'its "env" is not a JSON object' };
  }
  if (!Object.hasOwn(env, key)) {
    return { kind: "absent" };
  }
  const value = env[key];
  return {
    kind: "set",
    value: typeof value === "string" ? value : JSON.stringify(value),
  };
}

export function setEnvKey(
  content: string | null,
  key: string,
  value: string,
): SetEnvKeyResult {
  const reading = readEnvKey(content, key);
  if (reading.kind === "invalid") {
    return reading;
  }
  if (reading.kind === "set") {
    return reading.value === value
      ? { kind: "unchanged" }
      : { kind: "conflict", currentValue: reading.value };
  }
  return {
    kind: "changed",
    nextContent: insertEnvKey(content ?? "{}\n", key, value),
  };
}

export function removeEnvKey(
  content: string,
  key: string,
  expectedValue: string,
): RemoveEnvKeyResult {
  const reading = readEnvKey(content, key);
  if (reading.kind === "invalid") {
    return reading;
  }
  if (reading.kind === "absent") {
    return { kind: "unchanged" };
  }
  if (reading.value !== expectedValue) {
    return { kind: "conflict", currentValue: reading.value };
  }
  const nextContent = deleteEnvKey(content, key);
  return {
    kind: "removed",
    nextContent,
    settingsAreEmpty: Object.keys(JSON.parse(nextContent)).length === 0,
  };
}
