const ENV_MEMBER = "env";
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

export interface ObjectMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

export function skipWhitespace(text: string, index: number): number {
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

export function endOfContainer(text: string, opening: number): number {
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

export function endOfValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    return endOfString(text, start);
  }
  return first === "{" || first === "["
    ? endOfContainer(text, start)
    : endOfPrimitive(text, start);
}

export function objectMembers(text: string, opening: number): ObjectMember[] {
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

export function whitespaceBefore(text: string, index: number): string {
  return /\s*$/u.exec(text.slice(0, index))?.[0] ?? "";
}

export function replaceRange(
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

export function effectiveMemberIndex(
  members: ObjectMember[],
  key: string,
): number {
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

export interface TextSpan {
  start: number;
  end: number;
}

export function removeSpan(
  text: string,
  opening: number,
  spans: TextSpan[],
  index: number,
): string {
  const span = spans[index];
  const previous = spans[index - 1];
  const next = spans[index + 1];
  if (next !== undefined) {
    return replaceRange(text, span.start, next.start, "");
  }
  if (previous !== undefined) {
    return replaceRange(text, previous.end, span.end, "");
  }
  return replaceRange(text, opening + 1, endOfContainer(text, opening) - 1, "");
}

export function removeMember(
  text: string,
  opening: number,
  key: string,
): string {
  const members = objectMembers(text, opening);
  const spans = members.map((member) => ({
    start: member.keyStart,
    end: member.valueEnd,
  }));
  return removeSpan(text, opening, spans, effectiveMemberIndex(members, key));
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

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SettingsParse =
  | { kind: "parsed"; settings: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

export function parseSettings(content: string): SettingsParse {
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
  return isPlainObject(settings)
    ? { kind: "parsed", settings }
    : { kind: "invalid", reason: "its top level is not a JSON object" };
}

export function readEnvKey(content: string | null, key: string): EnvKeyReading {
  if (content === null) {
    return { kind: "absent" };
  }
  const parsed = parseSettings(content);
  if (parsed.kind === "invalid") {
    return parsed;
  }
  const { settings } = parsed;
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
