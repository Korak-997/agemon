import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { resolveImmutableBackupPath } from "../../../src/core/backups.js";
import {
  addCapabilitiesToConfig,
  capabilitiesToAutoAdd,
  outcomeUpdatesConfig,
} from "../../../src/core/capability-migration.js";
import {
  type AgemonConfig,
  loadConfig,
  rewriteConfigCapabilities,
} from "../../../src/core/config.js";
import type { RunOutcome } from "../../../src/core/orchestrator.js";
import { getRegisteredPlugins } from "../../../src/plugins/index.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

const PRE_AGENTS_CONFIG = `# shared by the team
capabilities = ["crg", "daemon", "skills", "master-prompt"]
skill_groups = "essentials,geo-seo"

[custom_skill_groups.house]
label = "House \\"style\\" — ünïcode"
skills = [
  { source = "./tools/skills/house-style" },
  { source = "github:acme/agent-skills", ref = "${"a".repeat(40)}", skill = "lint-rules" },
]

[conflict_decisions]
"rule-file:CLAUDE.md" = "keep"
`;

async function repoWithConfig(contents: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-capability-migration-"));
  createdTempDirectories.push(cwd);
  await writeFile(join(cwd, "agemon.toml"), contents, "utf8");
  return cwd;
}

async function configOf(cwd: string): Promise<AgemonConfig> {
  const config = await loadConfig(cwd);
  if (config === null) {
    throw new Error("agemon.toml missing");
  }
  return config;
}

describe("capabilities added to an existing agemon.toml", () => {
  it("adds agents to a file written before agemon knew it, when skills is listed", async () => {
    const config = await configOf(await repoWithConfig(PRE_AGENTS_CONFIG));

    expect(capabilitiesToAutoAdd(config, getRegisteredPlugins())).toEqual([
      "agents",
    ]);
  });

  it("never adds agents without skills, so skills cannot come back", async () => {
    const config = await configOf(
      await repoWithConfig('capabilities = ["crg", "master-prompt"]\n'),
    );

    expect(capabilitiesToAutoAdd(config, getRegisteredPlugins())).toEqual([]);
  });

  it("keeps agents removed once the file says agemon knew it", async () => {
    const config = await configOf(
      await repoWithConfig(
        'capabilities = ["skills"]\nknown_capabilities = ["skills", "agents"]\n',
      ),
    );

    expect(capabilitiesToAutoAdd(config, getRegisteredPlugins())).toEqual([]);
  });

  it("adds only capabilities on the explicit list, whatever the file has not seen", async () => {
    const config = await configOf(
      await repoWithConfig(
        'capabilities = ["crg"]\nknown_capabilities = ["crg"]\n',
      ),
    );

    expect(capabilitiesToAutoAdd(config, getRegisteredPlugins())).toEqual([]);
  });

  it("rejects a malformed known_capabilities", async () => {
    const cwd = await repoWithConfig(
      'capabilities = ["crg"]\nknown_capabilities = "agents"\n',
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      "'known_capabilities' must be an array of non-empty strings",
    );
  });
});

describe("rewriting agemon.toml", () => {
  it("keeps every value, backs up the commented original and records what agemon knows", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    const config = await configOf(cwd);

    const update = await rewriteConfigCapabilities(cwd, config, {
      capabilities: [...config.capabilities, "agents"],
      knownCapabilities: ["crg", "skills", "agents"],
    });

    const rewritten = parse(await readFile(join(cwd, "agemon.toml"), "utf8"));
    const original = parse(PRE_AGENTS_CONFIG);
    expect(rewritten).toEqual({
      ...original,
      capabilities: ["crg", "daemon", "skills", "master-prompt", "agents"],
      known_capabilities: ["crg", "skills", "agents"],
    });
    expect(update.kind).toBe("written");
    const backupPath = update.kind === "written" ? update.backupPath : null;
    expect(backupPath).toMatch(/^\.agemon\/backups\//u);
    expect(await readFile(join(cwd, backupPath ?? ""), "utf8")).toBe(
      PRE_AGENTS_CONFIG,
    );
    expect((await configOf(cwd)).customSkillGroups).toEqual(
      config.customSkillGroups,
    );
  });

  it("a second auto-added capability keeps the first saved original and writes its own backup", async () => {
    const firstOriginal = '# first\ncapabilities = ["crg", "skills"]\n';
    const cwd = await repoWithConfig(firstOriginal);
    const firstUpdate = await rewriteConfigCapabilities(
      cwd,
      await configOf(cwd),
      {
        capabilities: ["crg", "skills", "agents"],
        knownCapabilities: ["crg", "skills", "agents"],
      },
    );
    const secondOriginal = `# second\n${await readFile(join(cwd, "agemon.toml"), "utf8")}`;
    await writeFile(join(cwd, "agemon.toml"), secondOriginal, "utf8");

    const secondUpdate = await rewriteConfigCapabilities(
      cwd,
      await configOf(cwd),
      {
        capabilities: ["crg", "skills", "agents", "daemon"],
        knownCapabilities: ["crg", "skills", "agents", "daemon"],
      },
    );

    const firstPath =
      firstUpdate.kind === "written" ? firstUpdate.backupPath : null;
    const secondPath =
      secondUpdate.kind === "written" ? secondUpdate.backupPath : null;
    expect(firstPath).not.toBeNull();
    expect(secondPath).not.toBeNull();
    expect(secondPath).not.toBe(firstPath);
    expect(basename(firstPath ?? "")).toMatch(
      /^config_agemon\.toml_agents_[0-9a-f]{16}-[0-9a-f]{12}\.bak$/u,
    );
    expect(basename(secondPath ?? "")).toMatch(
      /^config_agemon\.toml_daemon_[0-9a-f]{16}-[0-9a-f]{12}\.bak$/u,
    );
    expect(await readFile(join(cwd, firstPath ?? ""), "utf8")).toBe(
      firstOriginal,
    );
    expect(await readFile(join(cwd, secondPath ?? ""), "utf8")).toBe(
      secondOriginal,
    );
  });

  it.each([
    [
      "a directory",
      async (path: string) => {
        await mkdir(path, { recursive: true });
      },
    ],
    [
      "a FIFO",
      async (path: string) => {
        await mkdir(dirname(path), { recursive: true });
        execFileSync("mkfifo", [path]);
      },
    ],
  ])(
    "%s at the backup path stops the rewrite and leaves agemon.toml unchanged",
    async (_label, plant) => {
      const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
      const config = await configOf(cwd);
      const update = {
        capabilities: [...config.capabilities, "agents"],
        knownCapabilities: ["crg", "skills", "agents"],
      };
      const backupId = `config:agemon.toml:agents:${createHash("sha256").update(PRE_AGENTS_CONFIG).digest("hex").slice(0, 16)}`;
      const backupPath = resolveImmutableBackupPath(cwd, backupId);
      await plant(backupPath);

      const refused = await rewriteConfigCapabilities(cwd, config, update);

      expect(refused).toEqual({
        kind: "not-written",
        reason: `agemon's backup path ${relative(cwd, backupPath)} holds something else; move it aside and run agemon again`,
      });
      expect(await readFile(join(cwd, "agemon.toml"), "utf8")).toBe(
        PRE_AGENTS_CONFIG,
      );
    },
  );

  it("a retried auto-add rewrite does not overwrite its earlier backup", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    const config = await configOf(cwd);
    const update = {
      capabilities: [...config.capabilities, "agents"],
      knownCapabilities: ["crg", "skills", "agents"],
    };
    const first = await rewriteConfigCapabilities(cwd, config, update);
    await writeFile(join(cwd, "agemon.toml"), PRE_AGENTS_CONFIG, "utf8");

    const retried = await rewriteConfigCapabilities(cwd, config, update);

    expect(retried).toEqual(first);
    const backupPath = first.kind === "written" ? first.backupPath : "";
    expect(await readFile(join(cwd, backupPath ?? ""), "utf8")).toBe(
      PRE_AGENTS_CONFIG,
    );
  });

  it("a pre-planted different file at the backup path stops the rewrite and names the path", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    const config = await configOf(cwd);
    const update = {
      capabilities: [...config.capabilities, "agents"],
      knownCapabilities: ["crg", "skills", "agents"],
    };
    const written = await rewriteConfigCapabilities(cwd, config, update);
    const backupPath = written.kind === "written" ? written.backupPath : "";
    await writeFile(join(cwd, backupPath ?? ""), "planted\n", "utf8");
    await writeFile(join(cwd, "agemon.toml"), PRE_AGENTS_CONFIG, "utf8");

    const refused = await rewriteConfigCapabilities(cwd, config, update);

    expect(refused).toEqual({
      kind: "not-written",
      reason: `agemon's backup path ${backupPath} holds something else; move it aside and run agemon again`,
    });
    expect(await readFile(join(cwd, "agemon.toml"), "utf8")).toBe(
      PRE_AGENTS_CONFIG,
    );
  });

  it("keeps ids a newer agemon wrote and takes no backup for a file in agemon's own layout", async () => {
    const original =
      'capabilities = [ "skills" ]\nknown_capabilities = [ "future" ]\n\n';
    const cwd = await repoWithConfig(original);
    const config = await configOf(cwd);

    const update = await rewriteConfigCapabilities(cwd, config, {
      capabilities: ["skills", "agents"],
      knownCapabilities: ["skills", "agents"],
    });

    expect(update).toEqual({ kind: "written", backupPath: null });
    expect(
      parse(await readFile(join(cwd, "agemon.toml"), "utf8"))
        .known_capabilities,
    ).toEqual(["future", "skills", "agents"]);
  });

  it("writes nothing when the file changed since the run read it", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    const config = await configOf(cwd);
    await writeFile(join(cwd, "agemon.toml"), 'capabilities = ["crg"]\n');

    const update = await rewriteConfigCapabilities(cwd, config, {
      capabilities: ["crg", "agents"],
      knownCapabilities: ["crg", "agents"],
    });

    expect(update).toEqual({
      kind: "not-written",
      reason: "it changed during this run",
    });
    expect(await readFile(join(cwd, "agemon.toml"), "utf8")).toBe(
      'capabilities = ["crg"]\n',
    );
  });
});

describe("when agemon records an added capability", () => {
  it.each([
    ["applied", true],
    ["nothing-to-do", true],
    ["partial", true],
    ["declined", true],
    ["drift", false],
    ["previewed", false],
  ] as [RunOutcome, boolean][])("after a %s run: %s", (outcome, updates) => {
    expect(outcomeUpdatesConfig(outcome)).toBe(updates);
  });

  it("leaves agemon.toml and .agemon alone while /.agemon/ is not git-ignored", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    const config = await configOf(cwd);
    const update = {
      knownCapabilities: ["agents"],
      allowUnignoredState: false,
    };

    expect(
      await addCapabilitiesToConfig(cwd, config, ["agents"], update),
    ).toEqual({ kind: "state-not-ignored" });
    expect(await readFile(join(cwd, "agemon.toml"), "utf8")).toBe(
      PRE_AGENTS_CONFIG,
    );
    expect(await lstat(join(cwd, ".agemon")).catch(() => null)).toBeNull();

    await writeFile(join(cwd, ".gitignore"), "/.agemon/\n");
    expect(
      (await addCapabilitiesToConfig(cwd, config, ["agents"], update)).kind,
    ).toBe("written");
  });

  it("leaves agemon.toml alone when git says a later rule re-includes .agemon", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);
    execFileSync("git", ["init", "-q", cwd]);
    await writeFile(join(cwd, ".gitignore"), "/.agemon/\n!/.agemon/\n");

    expect(
      await addCapabilitiesToConfig(cwd, await configOf(cwd), ["agents"], {
        knownCapabilities: ["agents"],
        allowUnignoredState: false,
      }),
    ).toEqual({ kind: "state-not-ignored" });
    expect(await readFile(join(cwd, "agemon.toml"), "utf8")).toBe(
      PRE_AGENTS_CONFIG,
    );
  });

  it("writes with --allow-unignored-state even when /.agemon/ is not ignored", async () => {
    const cwd = await repoWithConfig(PRE_AGENTS_CONFIG);

    const update = await addCapabilitiesToConfig(
      cwd,
      await configOf(cwd),
      ["agents"],
      { knownCapabilities: ["agents"], allowUnignoredState: true },
    );

    expect(update.kind).toBe("written");
  });
});
