import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../../src/adapters/claude-code.js";
import { buildDiscoveryResult } from "./discovery-fixture.js";

describe("claudeCodeAdapter.discoverProjectResources", () => {
  it("reports every resource absent when nothing is configured", () => {
    const resources = claudeCodeAdapter.discoverProjectResources(
      buildDiscoveryResult(),
    );

    expect(resources.map((resource) => resource.path).sort()).toEqual(
      [".claude/settings.json", ".mcp.json", "CLAUDE.md"].sort(),
    );
    expect(resources.every((resource) => !resource.exists)).toBe(true);
  });

  it("reports present resources when CLAUDE.md and .mcp.json exist", () => {
    const discovery = buildDiscoveryResult({
      ruleFiles: [
        { kind: "rule-file", path: "CLAUDE.md", exists: true, contents: "" },
        {
          kind: "rule-file",
          path: "GEMINI.md",
          exists: false,
          contents: null,
        },
      ],
      structuredConfigs: [
        {
          kind: "structured-config",
          path: ".mcp.json",
          exists: true,
          parsed: {},
          parseError: null,
          denylisted: false,
        },
        {
          kind: "structured-config",
          path: ".claude/settings.json",
          exists: false,
          parsed: null,
          parseError: null,
          denylisted: false,
        },
      ],
    });

    const resources = claudeCodeAdapter.discoverProjectResources(discovery);
    const byPath = new Map(
      resources.map((resource) => [resource.path, resource]),
    );

    expect(byPath.get("CLAUDE.md")?.exists).toBe(true);
    expect(byPath.get(".mcp.json")?.exists).toBe(true);
    expect(byPath.get(".claude/settings.json")?.exists).toBe(false);
  });

  it("does not surface GEMINI.md or Copilot resources", () => {
    const discovery = buildDiscoveryResult({
      ruleFiles: [
        { kind: "rule-file", path: "GEMINI.md", exists: true, contents: "" },
      ],
      copilotInstructions: [
        {
          kind: "copilot-instruction",
          path: ".github/copilot-instructions.md",
          exists: true,
        },
      ],
    });

    const resources = claudeCodeAdapter.discoverProjectResources(discovery);

    expect(resources.some((resource) => resource.path === "GEMINI.md")).toBe(
      false,
    );
    expect(
      resources.some(
        (resource) => resource.path === ".github/copilot-instructions.md",
      ),
    ).toBe(false);
  });
});
