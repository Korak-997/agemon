import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveVendoredSkillPath } from "../../../src/core/package-assets.js";
import {
  invokedOnlyByName,
  portableSkillManifest,
} from "../../../src/plugins/skills/portable-manifest.js";

const BODY = "\n# Title\n\nversion: not frontmatter\n";

function manifest(...frontmatterLines: string[]): string {
  return `---\n${frontmatterLines.join("\n")}\n---\n${BODY}`;
}

describe("portableSkillManifest", () => {
  it("returns a manifest with only standard keys byte for byte", () => {
    const source = manifest(
      "name: tidy",
      "description: >-",
      "  Folded text: with a colon.",
      "license: MIT",
      "compatibility: Needs git",
      "allowed-tools: Read",
    );

    expect(portableSkillManifest(source)).toBe(source);
  });

  it("moves agemon's non-standard keys into metadata as strings", () => {
    const source = manifest(
      "name: tidy",
      "description: Tidies things",
      "version: 1.2.0",
      'author: "Ada"',
      'tags: ["a", "b"]',
      'triggers: ["@tidy", "clean up"]',
      "argument-hint: '[path]'",
    );

    expect(portableSkillManifest(source)).toBe(
      manifest(
        "name: tidy",
        "description: Tidies things",
        "metadata:",
        '  version: "1.2.0"',
        '  author: "Ada"',
        '  tags: "[\\"a\\", \\"b\\"]"',
        '  triggers: "[\\"@tidy\\", \\"clean up\\"]"',
        '  argument-hint: "[path]"',
      ),
    );
  });

  it("skips comments when reading a metadata block's indentation", () => {
    const source = manifest(
      "name: t",
      "metadata:",
      "      # a note: here",
      "  owner: ada",
      "version: 1",
    );

    expect(portableSkillManifest(source)).toBe(
      manifest(
        "name: t",
        "metadata:",
        "      # a note: here",
        "  owner: ada",
        '  version: "1"',
      ),
    );
  });

  it("adds moved keys to an existing metadata block at its indentation", () => {
    const source = manifest(
      "name: tidy",
      "metadata:",
      "    owner: ada",
      "description: Tidies things",
      "version: 1.2.0",
    );

    expect(portableSkillManifest(source)).toBe(
      manifest(
        "name: tidy",
        "metadata:",
        "    owner: ada",
        '    version: "1.2.0"',
        "description: Tidies things",
      ),
    );
  });

  it("keeps a block list together as one metadata string", () => {
    const source = manifest(
      "name: tidy",
      "description: Tidies things",
      "tags:",
      "  - a",
      "  - b",
    );

    expect(portableSkillManifest(source)).toBe(
      manifest(
        "name: tidy",
        "description: Tidies things",
        "metadata:",
        '  tags: "- a\\n- b"',
      ),
    );
  });

  it.each([
    [
      "metadata that is not a block",
      ["name: t", "metadata: { owner: ada }", "version: 1"],
    ],
    [
      "a moved key already in metadata",
      ["name: t", "metadata:", "  version: 2", "version: 1"],
    ],
    ["a metadata list", ["name: t", "metadata:", "  - a: 1", "version: 1"]],
    ["metadata plain text", ["name: t", "metadata:", "  text", "version: 1"]],
    [
      "a quoted metadata key",
      ["name: t", "metadata:", '  "version": 2', "version: 1"],
    ],
    ["a quoted top-level name", ["version: 1", '"name": t']],
    ["a quoted top-level description", ["name: t", "version: 1", '"d": x']],
  ])("returns null for %s", (_label, lines) => {
    expect(portableSkillManifest(manifest(...lines))).toBeNull();
  });

  it("returns a manifest without frontmatter unchanged", () => {
    expect(portableSkillManifest("# Just text\n")).toBe("# Just text\n");
  });

  it("leaves the bundled agemon-design name and description unchanged", async () => {
    const source = await readFile(
      `${resolveVendoredSkillPath("design", "agemon-design")}/SKILL.md`,
      "utf8",
    );
    const line = (text: string, key: string) =>
      text.split("\n").find((candidate) => candidate.startsWith(`${key}:`));

    const portable = portableSkillManifest(source) ?? "";

    expect(line(portable, "name")).toBe(line(source, "name"));
    expect(line(portable, "description")).toBe(line(source, "description"));
    expect(line(portable, "argument-hint")).toBeUndefined();
  });
});

describe("invokedOnlyByName", () => {
  it("is true for agemon-adhd, whose flag not every agent honours", async () => {
    const source = await readFile(
      `${resolveVendoredSkillPath("output-style", "agemon-adhd")}/SKILL.md`,
      "utf8",
    );

    expect(invokedOnlyByName(source)).toBe(true);
  });

  it.each([
    "disable-model-invocation: true # by name",
    "disable-model-invocation: True",
    'disable-model-invocation: "true"',
    '"disable-model-invocation": true',
    "disable-model-invocation: yes",
    "disable-model-invocation:",
  ])("fails closed on %s", (line) => {
    expect(invokedOnlyByName(manifest("name: tidy", line))).toBe(true);
  });

  it("is false without the flag or when the flag is false", () => {
    expect(invokedOnlyByName(manifest("name: tidy"))).toBe(false);
    expect(
      invokedOnlyByName(
        manifest("name: tidy", "disable-model-invocation: false"),
      ),
    ).toBe(false);
  });
});
