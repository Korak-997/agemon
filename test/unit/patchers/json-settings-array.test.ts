import { describe, expect, it } from "vitest";
import {
  addArrayEntry,
  readArrayEntries,
  removeArrayEntry,
} from "../../../src/patchers/json-settings-array.js";

const DENY_PATH = ["permissions", "deny"] as const;
const PRE_TOOL_USE_PATH = ["hooks", "PreToolUse"] as const;
const AGEMON_HOOK = {
  matcher: "Read|Grep|Glob|Agent",
  hooks: [{ type: "command", command: "node guard.mjs", timeout: 5 }],
};

function changedContent(result: ReturnType<typeof addArrayEntry>): string {
  if (result.kind !== "changed") {
    throw new Error(`expected a change, got ${result.kind}`);
  }
  return result.nextContent;
}

function removedContent(result: ReturnType<typeof removeArrayEntry>): string {
  if (result.kind !== "removed") {
    throw new Error(`expected a removal, got ${result.kind}`);
  }
  return result.nextContent;
}

describe("addArrayEntry", () => {
  it("adds an entry to a missing nested array", () => {
    expect(
      changedContent(
        addArrayEntry(
          '{\n  "env": {"A": "1"}\n}\n',
          DENY_PATH,
          "Agent(model:opus)",
        ),
      ),
    ).toBe(
      '{\n  "env": {"A": "1"},\n  "permissions": {\n    "deny": [\n      "Agent(model:opus)"\n    ]\n  }\n}\n',
    );
    expect(changedContent(addArrayEntry(null, DENY_PATH, "x"))).toBe(
      '{\n  "permissions": {\n    "deny": [\n      "x"\n    ]\n  }\n}\n',
    );
  });

  it("appends after the user's own entries and keeps their formatting byte-identical", () => {
    const userEntry = '{"matcher": "Bash",  "hooks": [ ]}';
    const original = `{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t${userEntry}\n\t\t]\n\t}\n}\n`;

    const next = changedContent(
      addArrayEntry(original, PRE_TOOL_USE_PATH, "x"),
    );

    expect(next).toBe(
      `{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t${userEntry},\n\t\t\t"x"\n\t\t]\n\t}\n}\n`,
    );
  });

  it("fills an empty array and an empty object in the file's own layout", () => {
    expect(
      changedContent(
        addArrayEntry(
          '{\r\n  "hooks": {\r\n    "PreToolUse": []\r\n  }\r\n}\r\n',
          PRE_TOOL_USE_PATH,
          "x",
        ),
      ),
    ).toBe(
      '{\r\n  "hooks": {\r\n    "PreToolUse": [\r\n      "x"\r\n    ]\r\n  }\r\n}\r\n',
    );
    expect(
      changedContent(
        addArrayEntry('{\n  "hooks": {}\n}\n', PRE_TOOL_USE_PATH, "x"),
      ),
    ).toBe('{\n  "hooks": {\n    "PreToolUse": [\n      "x"\n    ]\n  }\n}\n');
  });

  it("is unchanged when an equal entry with different key order exists", () => {
    const original = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ timeout: 5, command: "node guard.mjs", type: "command" }],
            matcher: "Read|Grep|Glob|Agent",
          },
        ],
      },
    });

    expect(addArrayEntry(original, PRE_TOOL_USE_PATH, AGEMON_HOOK)).toEqual({
      kind: "unchanged",
    });
  });

  it("reports invalid for non-UTF-8, non-object roots and non-array targets", () => {
    expect(addArrayEntry('{"a": "�"}', DENY_PATH, "x")).toEqual({
      kind: "invalid",
      reason:
        "it is not clean UTF-8, so it could not be written back unchanged",
    });
    expect(addArrayEntry("{", DENY_PATH, "x")).toEqual({
      kind: "invalid",
      reason: "it is not valid JSON",
    });
    expect(addArrayEntry("[]", DENY_PATH, "x")).toEqual({
      kind: "invalid",
      reason: "its top level is not a JSON object",
    });
    expect(addArrayEntry('{"permissions": []}', DENY_PATH, "x")).toEqual({
      kind: "invalid",
      reason: 'its "permissions" is not a JSON object',
    });
    expect(
      addArrayEntry('{"permissions": {"deny": "x"}}', DENY_PATH, "x"),
    ).toEqual({
      kind: "invalid",
      reason: 'its "permissions.deny" is not a JSON array',
    });
  });
});

describe("removeArrayEntry", () => {
  it("removes only agemon's entry and leaves user entries and order intact", () => {
    const original =
      '{\n  "hooks": {\n    "PreToolUse": [\n      {"matcher": "Bash", "hooks": []},\n      {"matcher": "Edit", "hooks": []}\n    ]\n  }\n}\n';
    const added = changedContent(
      addArrayEntry(original, PRE_TOOL_USE_PATH, AGEMON_HOOK),
    );
    expect(
      removedContent(removeArrayEntry(added, PRE_TOOL_USE_PATH, AGEMON_HOOK)),
    ).toBe(original);

    const agemonInTheMiddle =
      '{"deny": ["A", "Agent(model:opus)", "B"], "allow": ["C"]}';
    expect(
      removedContent(
        removeArrayEntry(agemonInTheMiddle, ["deny"], "Agent(model:opus)"),
      ),
    ).toBe('{"deny": ["A", "B"], "allow": ["C"]}');
  });

  it("removes the containers it emptied and says when the settings are empty", () => {
    const added = changedContent(addArrayEntry("{}\n", DENY_PATH, "x"));
    expect(removeArrayEntry(added, DENY_PATH, "x")).toEqual({
      kind: "removed",
      nextContent: "{}\n",
      settingsAreEmpty: true,
    });

    const original = '{\n  "env": {"A": "1"}\n}\n';
    const withEntry = changedContent(addArrayEntry(original, DENY_PATH, "x"));
    expect(removeArrayEntry(withEntry, DENY_PATH, "x")).toEqual({
      kind: "removed",
      nextContent: original,
      settingsAreEmpty: false,
    });
  });

  it("is unchanged when the entry or its array is gone", () => {
    expect(removeArrayEntry('{"deny": ["A"]}', ["deny"], "x")).toEqual({
      kind: "unchanged",
    });
    expect(removeArrayEntry("{}", DENY_PATH, "x")).toEqual({
      kind: "unchanged",
    });
  });
});

describe("readArrayEntries", () => {
  it("tells absent, present and invalid apart", () => {
    expect(readArrayEntries(null, DENY_PATH)).toEqual({ kind: "absent" });
    expect(readArrayEntries('{"permissions": {}}', DENY_PATH)).toEqual({
      kind: "absent",
    });
    expect(
      readArrayEntries('{"permissions": {"deny": ["A"]}}', DENY_PATH),
    ).toEqual({ kind: "present", entries: ["A"] });
    expect(readArrayEntries("null", DENY_PATH).kind).toBe("invalid");
  });
});
