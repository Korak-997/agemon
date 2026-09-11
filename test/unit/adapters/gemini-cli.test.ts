import { describe, expect, it } from "vitest";
import { geminiCliAdapter } from "../../../src/adapters/gemini-cli.js";
import { buildDiscoveryResult } from "./discovery-fixture.js";

describe("geminiCliAdapter.discoverProjectResources", () => {
  it("reports every resource absent when nothing is configured", () => {
    const resources = geminiCliAdapter.discoverProjectResources(
      buildDiscoveryResult(),
    );

    expect(resources.map((resource) => resource.path).sort()).toEqual(
      [".gemini/settings.json", "GEMINI.md"].sort(),
    );
    expect(resources.every((resource) => !resource.exists)).toBe(true);
  });

  it("reports present resources when GEMINI.md and .gemini/settings.json exist", () => {
    const discovery = buildDiscoveryResult({
      ruleFiles: [
        { kind: "rule-file", path: "GEMINI.md", exists: true, contents: "" },
      ],
      structuredConfigs: [
        {
          kind: "structured-config",
          path: ".gemini/settings.json",
          exists: true,
          parsed: {},
          parseError: null,
          denylisted: false,
        },
      ],
    });

    const resources = geminiCliAdapter.discoverProjectResources(discovery);

    expect(resources.every((resource) => resource.exists)).toBe(true);
  });

  it("does not surface CLAUDE.md resources", () => {
    const discovery = buildDiscoveryResult({
      ruleFiles: [
        { kind: "rule-file", path: "CLAUDE.md", exists: true, contents: "" },
      ],
    });

    const resources = geminiCliAdapter.discoverProjectResources(discovery);

    expect(resources.some((resource) => resource.path === "CLAUDE.md")).toBe(
      false,
    );
  });
});
