import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeConfig } from "../../../src/core/config.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-config-test-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("agemon.toml config", () => {
  it("returns null when the file is absent", async () => {
    const cwd = await createSandbox();
    expect(await loadConfig(cwd)).toBeNull();
  });

  it("round-trips capabilities, skill groups, and conflict decisions", async () => {
    const cwd = await createSandbox();

    await writeConfig(cwd, {
      capabilities: ["crg", "master-prompt"],
      skillGroups: "essentials,design",
      conflictDecisions: { "rule-file:CLAUDE.md": "skip" },
    });

    const reloaded = await loadConfig(cwd);
    expect(reloaded).toEqual({
      capabilities: ["crg", "master-prompt"],
      skillGroups: "essentials,design",
      customSkillGroups: [],
      conflictDecisions: { "rule-file:CLAUDE.md": "skip" },
    });
  });

  it("omits skill_groups from the file when none is chosen", async () => {
    const cwd = await createSandbox();

    await writeConfig(cwd, {
      capabilities: ["crg"],
      skillGroups: null,
      conflictDecisions: {},
    });

    const contents = await readFile(join(cwd, "agemon.toml"), "utf8");
    expect(contents).not.toContain("skill_groups");
    expect((await loadConfig(cwd))?.skillGroups).toBeNull();
  });

  it("fails closed on invalid TOML", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "agemon.toml"), "capabilities = [oops", "utf8");

    await expect(loadConfig(cwd)).rejects.toThrow(/not valid TOML/);
  });

  it("fails closed on an unknown conflict decision", async () => {
    const cwd = await createSandbox();
    await writeFile(
      join(cwd, "agemon.toml"),
      'capabilities = ["crg"]\n\n[conflict_decisions]\n"rule-file:CLAUDE.md" = "overwrite"\n',
      "utf8",
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      /"keep", "replace", or "skip"/,
    );
  });

  it("fails closed when capabilities is not an array of strings", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "agemon.toml"), "capabilities = 3\n", "utf8");

    await expect(loadConfig(cwd)).rejects.toThrow(/capabilities/);
  });

  it("fails closed on an unknown top-level key and lists the valid keys", async () => {
    const cwd = await createSandbox();
    await writeFile(
      join(cwd, "agemon.toml"),
      'capabilities = ["crg"]\nskill_group = "all"\n',
      "utf8",
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      "agemon.toml is invalid: unknown key 'skill_group'. Valid keys: capabilities, skill_groups, custom_skill_groups, conflict_decisions.",
    );
  });

  it("fails closed when capabilities is empty", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "agemon.toml"), "capabilities = []\n", "utf8");

    await expect(loadConfig(cwd)).rejects.toThrow(
      "'capabilities' must list at least one capability id",
    );
  });

  it("refuses an agemon.toml that links to /dev/zero instead of hanging", async () => {
    const cwd = await createSandbox();
    await symlink("/dev/zero", join(cwd, "agemon.toml"));

    await expect(loadConfig(cwd)).rejects.toThrow(
      /agemon\.toml is invalid: .*not a regular file/,
    );
  }, 2000);

  it("prints control characters in a conflict decision key safely", async () => {
    const cwd = await createSandbox();
    await writeFile(
      join(cwd, "agemon.toml"),
      'capabilities = ["crg"]\n\n[conflict_decisions]\n"rule\\u001b[2J" = "overwrite"\n',
      "utf8",
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      /'conflict_decisions\.rule\?\[2J' must be/,
    );
  });
});

describe("custom_skill_groups", () => {
  async function loadToml(toml: string) {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "agemon.toml"), toml, "utf8");
    return loadConfig(cwd);
  }

  const REF = "4f2c8a1b9d3e5f7a0b2c4d6e8f1a3b5c7d9e0f12";

  it("parses local and GitHub sources", async () => {
    const config = await loadToml(`capabilities = ["skills"]
skill_groups = "essentials,house-style"

[custom_skill_groups.house-style]
label = "House style"
skills = [
  { source = "./tools/skills/house-rules" },
  { source = "github:acme/agent-skills", ref = "${REF}", skill = "lint-rules" },
]
`);

    expect(config?.customSkillGroups).toEqual([
      {
        id: "house-style",
        label: "House style",
        skills: [
          {
            kind: "local",
            path: "./tools/skills/house-rules",
            skillName: "house-rules",
          },
          {
            kind: "github",
            owner: "acme",
            repository: "agent-skills",
            ref: REF,
            skillName: "lint-rules",
          },
        ],
      },
    ]);
  });

  const group = (skills: string, id = "house-style", label = '"House"') =>
    `capabilities = ["skills"]\n[custom_skill_groups.${id}]\nlabel = ${label}\nskills = [${skills}]\n`;

  it.each([
    ["a reserved id", group('{ source = "./a/x" }', "all"), /not all or none/],
    [
      "an upper-case id",
      group('{ source = "./a/x" }', "House"),
      /a group id is lower-case/,
    ],
    ["an empty label", group('{ source = "./a/x" }', "g", '""'), /label/],
    [
      "a multi-line label",
      group('{ source = "./a/x" }', "g", '"a\\nb"'),
      /single-line/,
    ],
    ["no skills", group(""), /between 1 and 50 skills/],
    [
      "a label with a bidi override",
      group('{ source = "./a/x" }', "g", '"Security\u202e"'),
      /single-line/,
    ],
    [
      "an unknown group key",
      `${group('{ source = "./a/x" }')}extra = 1\n`,
      /unknown key 'extra'/,
    ],
    [
      "an absolute path",
      group('{ source = "/etc/x" }'),
      /repository-relative path/,
    ],
    [
      "a parent component",
      group('{ source = "./../x" }'),
      /repository-relative path/,
    ],
    [
      "a dot component",
      group('{ source = "./a/./x" }'),
      /repository-relative path/,
    ],
    [
      "a path without ./",
      group('{ source = "tools/x" }'),
      /repository-relative path/,
    ],
    [
      "a path into .agents",
      group('{ source = "./.agents/skills/x" }'),
      /must not point into \.agents or \.claude/,
    ],
    [
      "a path into .Claude",
      group('{ source = "./.Claude/skills/x" }'),
      /must not point into \.agents or \.claude/,
    ],
    [
      "a skill name starting with -",
      group('{ source = "./a/-rf" }'),
      /must be a skill name/,
    ],
    [
      "a local source with a ref",
      group(`{ source = "./a/x", ref = "${REF}" }`),
      /unknown key 'ref'/,
    ],
    [
      "a non-GitHub remote",
      group(
        `{ source = "git:ext::sh -c touch% /tmp/pwned", ref = "${REF}", skill = "x" }`,
      ),
      /unknown key 'ref'/,
    ],
    [
      "a malformed GitHub source",
      group(`{ source = "github:acme/a/b", ref = "${REF}", skill = "x" }`),
      /must be "github:<owner>\/<repository>"/,
    ],
    [
      "a missing ref",
      group('{ source = "github:acme/skills", skill = "x" }'),
      /full 40-character commit sha/,
    ],
    [
      "a branch ref",
      group('{ source = "github:acme/skills", ref = "main", skill = "x" }'),
      /full 40-character commit sha/,
    ],
    [
      "a short sha",
      group('{ source = "github:acme/skills", ref = "4f2c8a1", skill = "x" }'),
      /full 40-character commit sha/,
    ],
    [
      "a missing skill",
      group(`{ source = "github:acme/skills", ref = "${REF}" }`),
      /must be a skill name/,
    ],
    [
      "a duplicate skill name",
      group('{ source = "./a/x" }, { source = "./b/x" }'),
      /skill 'x' appears more than once/,
    ],
  ])("refuses %s", async (_label, toml, message) => {
    await expect(loadToml(toml)).rejects.toThrow(message);
  });

  it("refuses more than 10 GitHub repositories", async () => {
    const skills = Array.from(
      { length: 11 },
      (_, index) =>
        `{ source = "github:acme/repo${index}", ref = "${REF}", skill = "s${index}" }`,
    ).join(", ");

    await expect(loadToml(group(skills))).rejects.toThrow(
      /at most 10 GitHub repositories/,
    );
  });
});
