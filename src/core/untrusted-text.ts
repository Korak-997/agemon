const TERMINAL_UNSAFE_CHARACTER_RANGES =
  "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff";

const TERMINAL_UNSAFE_CHARACTERS = new RegExp(
  `[${TERMINAL_UNSAFE_CHARACTER_RANGES}]`,
  "gu",
);
const IDENTIFIER_UNSAFE_CHARACTERS = new RegExp(
  `[\\t\\n${TERMINAL_UNSAFE_CHARACTER_RANGES}]`,
  "u",
);

export function printable(value: string): string {
  return value.replace(TERMINAL_UNSAFE_CHARACTERS, "?");
}

export function isSafeIdentifier(value: string): boolean {
  return !IDENTIFIER_UNSAFE_CHARACTERS.test(value);
}
