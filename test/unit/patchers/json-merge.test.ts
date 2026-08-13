import { describe, expect, it } from "vitest";
import { mergeJsonObject } from "../../../src/patchers/json-merge.js";

describe("json-merge patcher", () => {
  it("deep-merges nested objects and replaces arrays", () => {
    const current = JSON.stringify(
      {
        mcpServers: {
          existing: { command: "node", args: ["a"] },
        },
        features: {
          flags: ["old"],
        },
      },
      null,
      2,
    );

    const merged = mergeJsonObject(current, {
      mcpServers: {
        existing: { args: ["a", "b"] },
        crg: { command: "pipx", args: ["run", "code-review-graph"] },
      },
      features: {
        flags: ["new"],
      },
    });

    const parsed = JSON.parse(merged.nextContent) as {
      mcpServers: {
        existing: { command: string; args: string[] };
        crg: { command: string; args: string[] };
      };
      features: { flags: string[] };
    };

    expect(merged.changed).toBe(true);
    expect(parsed.mcpServers.existing.command).toBe("node");
    expect(parsed.mcpServers.existing.args).toEqual(["a", "b"]);
    expect(parsed.mcpServers.crg.command).toBe("pipx");
    expect(parsed.features.flags).toEqual(["new"]);
  });

  it("is idempotent when the same patch is re-applied", () => {
    const first = mergeJsonObject("{}", {
      mcpServers: {
        crg: { command: "pipx", args: ["run"] },
      },
    });

    const second = mergeJsonObject(first.nextContent, {
      mcpServers: {
        crg: { command: "pipx", args: ["run"] },
      },
    });

    expect(second.changed).toBe(false);
    expect(second.nextContent).toBe(first.nextContent);
  });
});
