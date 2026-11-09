import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readEnvKey,
  removeEnvKey,
  setEnvKey,
} from "../../../src/patchers/json-settings-key.js";

const KEY = "CLAUDE_CODE_SUBAGENT_MODEL";
const VALUE = "sonnet";

function changedContent(result: ReturnType<typeof setEnvKey>): string {
  if (result.kind !== "changed") {
    throw new Error(`expected a change, got ${result.kind}`);
  }
  return result.nextContent;
}

describe("setEnvKey", () => {
  it("adds one key to this repo's settings and keeps every other key and their order", async () => {
    const original = await readFile(".claude/settings.json", "utf8");

    const next = changedContent(setEnvKey(original, KEY, VALUE));

    const parsed = JSON.parse(next);
    expect(parsed.env).toEqual({ [KEY]: VALUE });
    expect(Object.keys(parsed)).toEqual(["hooks", "env"]);
    expect(parsed.hooks).toEqual(JSON.parse(original).hooks);
    expect(next.startsWith(original.trimEnd().slice(0, -2))).toBe(true);
  });

  it("creates the settings when the file does not exist", () => {
    expect(changedContent(setEnvKey(null, KEY, VALUE))).toBe(
      `{\n  "env": {\n    "${KEY}": "${VALUE}"\n  }\n}\n`,
    );
  });

  it("fills an empty object", () => {
    expect(changedContent(setEnvKey("{}\n", KEY, VALUE))).toBe(
      `{\n  "env": {\n    "${KEY}": "${VALUE}"\n  }\n}\n`,
    );
  });

  it("appends to an existing env in that env's own layout", () => {
    expect(
      changedContent(
        setEnvKey('{\n\t"env": {\n\t\t"A": "1"\n\t}\n}\n', KEY, VALUE),
      ),
    ).toBe(`{\n\t"env": {\n\t\t"A": "1",\n\t\t"${KEY}": "${VALUE}"\n\t}\n}\n`);
    expect(changedContent(setEnvKey('{"env":{"A":"1"}}', KEY, VALUE))).toBe(
      `{"env":{"A":"1","${KEY}": "${VALUE}"}}`,
    );
  });

  it("fills an empty env and keeps line endings", () => {
    expect(
      changedContent(setEnvKey('{\r\n  "env": {}\r\n}\r\n', KEY, VALUE)),
    ).toBe(`{\r\n  "env": {\r\n    "${KEY}": "${VALUE}"\r\n  }\r\n}\r\n`);
  });

  it("leaves compact user formatting alone", () => {
    const original = '{\n  "permissions": { "allow": ["a", "b"] }\n}\n';

    expect(changedContent(setEnvKey(original, KEY, VALUE))).toBe(
      `{\n  "permissions": { "allow": ["a", "b"] },\n  "env": {\n    "${KEY}": "${VALUE}"\n  }\n}\n`,
    );
  });

  it("is not confused by braces and escapes in strings", () => {
    const original = '{\n  "a": "}\\"{",\n  "env": {\n    "B": "{,"\n  }\n}\n';

    const next = changedContent(setEnvKey(original, KEY, VALUE));

    expect(JSON.parse(next)).toEqual({
      a: '}"{',
      env: { B: "{,", [KEY]: VALUE },
    });
  });

  it("reports the same value as unchanged", () => {
    const original = `{ "env": { "${KEY}": "${VALUE}" } }`;

    expect(setEnvKey(original, KEY, VALUE)).toEqual({ kind: "unchanged" });
  });

  it("reports a user's different value as a conflict", () => {
    const original = `{ "env": { "${KEY}": "haiku" } }`;

    expect(setEnvKey(original, KEY, VALUE)).toEqual({
      kind: "conflict",
      currentValue: "haiku",
    });
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["a top level that is not an object", "[]"],
    ["an env that is not an object", '{ "env": 1 }'],
    ["bytes that were not valid UTF-8", '{ "a": "caf�" }'],
  ])("refuses %s", (_label, original) => {
    expect(setEnvKey(original, KEY, VALUE).kind).toBe("invalid");
  });
});

describe("removeEnvKey", () => {
  it.each([
    ["no env", '{\n  "hooks": {}\n}\n'],
    ["an env with other keys", '{\n  "env": {\n    "A": "1"\n  }\n}\n'],
    ["inline layout", '{"env":{"A":"1"}}'],
    ["CRLF line endings", '{\r\n  "a": 1\r\n}\r\n'],
    ["an empty object", "{}\n"],
  ])("exactly undoes setEnvKey on %s", (_label, original) => {
    const withKey = changedContent(setEnvKey(original, KEY, VALUE));

    expect(removeEnvKey(withKey, KEY, VALUE)).toEqual({
      kind: "removed",
      nextContent: original,
      settingsAreEmpty: original.startsWith("{}"),
    });
  });

  it("deletes only that key when it is not the last one", () => {
    const original = `{\n  "env": {\n    "${KEY}": "${VALUE}",\n    "A": "1"\n  }\n}\n`;

    expect(removeEnvKey(original, KEY, VALUE)).toMatchObject({
      nextContent: '{\n  "env": {\n    "A": "1"\n  }\n}\n',
    });
  });

  it("deletes an env it left empty, and only that", () => {
    const original = `{\n  "env": {\n    "${KEY}": "${VALUE}"\n  },\n  "hooks": {}\n}\n`;

    expect(removeEnvKey(original, KEY, VALUE)).toEqual({
      kind: "removed",
      nextContent: '{\n  "hooks": {}\n}\n',
      settingsAreEmpty: false,
    });
  });

  it("keeps a value that changed", () => {
    const original = `{ "env": { "${KEY}": "haiku" } }`;

    expect(removeEnvKey(original, KEY, VALUE)).toEqual({
      kind: "conflict",
      currentValue: "haiku",
    });
  });

  it("does nothing when the key is gone", () => {
    expect(removeEnvKey('{ "env": {} }', KEY, VALUE)).toEqual({
      kind: "unchanged",
    });
  });

  it("refuses invalid JSON", () => {
    expect(removeEnvKey("{ not json", KEY, VALUE).kind).toBe("invalid");
  });
});

describe("readEnvKey", () => {
  it("tells absent, set and invalid apart", () => {
    expect(readEnvKey(null, KEY)).toEqual({ kind: "absent" });
    expect(readEnvKey('{ "env": {} }', KEY)).toEqual({ kind: "absent" });
    expect(readEnvKey(`{ "env": { "${KEY}": "x" } }`, KEY)).toEqual({
      kind: "set",
      value: "x",
    });
    expect(readEnvKey("nope", KEY).kind).toBe("invalid");
  });

  it("does not read inherited object properties as settings", () => {
    expect(readEnvKey('{ "env": {} }', "toString")).toEqual({ kind: "absent" });
  });

  it("shows a value that is not a string as JSON", () => {
    expect(readEnvKey(`{ "env": { "${KEY}": 1 } }`, KEY)).toEqual({
      kind: "set",
      value: "1",
    });
  });
});
