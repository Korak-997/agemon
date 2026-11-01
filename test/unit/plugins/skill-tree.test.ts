import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakePinnedSkillFingerprint } from "../../../src/core/fake-pinned-skills.js";
import { ESSENTIALS_SKILLS_COMMIT } from "../../../src/plugins/pins.js";
import { BUNDLE_FINGERPRINTS } from "../../../src/plugins/skills/bundle-fingerprints.js";
import {
  findSkillGroup,
  SKILL_GROUPS,
} from "../../../src/plugins/skills/catalog.js";
import { readLocalSkill } from "../../../src/plugins/skills/local-source.js";
import {
  fingerprintInstalledSkill,
  fingerprintSkillSource,
  SKILLS_CLI_COPY_EXCLUSIONS,
} from "../../../src/plugins/skills/skill-tree.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-skill-tree-"));
  createdTempDirectories.push(directory);
  return directory;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function vendoredSkills() {
  return SKILL_GROUPS.flatMap((group) =>
    group.skills
      .filter((entry) => entry.pinnedRepository === undefined)
      .map((entry) => ({ entry })),
  );
}

async function namesBelow(directory: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) {
      names.push(...(await namesBelow(join(directory, entry.name))));
    }
  }
  return names;
}

describe("skill content fingerprints", () => {
  it("a directory named metadata.json in a source is left out, like the skills CLI does", async () => {
    const plain = await createDirectory();
    await writeFile(join(plain, "SKILL.md"), "x");
    const withExcluded = await createDirectory();
    await writeFile(join(withExcluded, "SKILL.md"), "x");
    await mkdir(join(withExcluded, "metadata.json"));
    await mkdir(join(withExcluded, "__pycache__"));
    await writeFile(join(withExcluded, "metadata.json/inner"), "y");

    expect(await fingerprintSkillSource(withExcluded)).toBe(
      await fingerprintSkillSource(plain),
    );
  });

  it("custom local fingerprints are unchanged by the shared reader", async () => {
    const repo = await createDirectory();
    const skill = join(repo, "skills/house");
    await mkdir(join(skill, "docs"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: house\n---\n");
    await writeFile(join(skill, "docs/a.md"), "a");

    const expected = sha256(
      JSON.stringify([
        ["SKILL.md", sha256("---\nname: house\n---\n")],
        ["docs", null],
        ["docs/a.md", sha256("a")],
      ]),
    );

    expect(
      (await readLocalSkill(repo, "./skills/house", "house")).fingerprint,
    ).toBe(expected);
  });
});

describe("bundle fingerprint guards", () => {
  it("every vendored skill's current fingerprint is in bundle history", async () => {
    for (const { entry } of vendoredSkills()) {
      const fingerprint = await fingerprintSkillSource(entry.source);
      expect(BUNDLE_FINGERPRINTS.history[entry.skillName]).toContain(
        fingerprint,
      );
    }
  });

  it("the current Essentials pin has fingerprints, and they are in history", () => {
    for (const entry of findSkillGroup("essentials")?.skills ?? []) {
      const fingerprint =
        BUNDLE_FINGERPRINTS.pinned[ESSENTIALS_SKILLS_COMMIT]?.[entry.skillName];
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(BUNDLE_FINGERPRINTS.history[entry.skillName]).toContain(
        fingerprint,
      );
    }
  });

  it("no vendored skill contains a symlink or a name the skills CLI leaves out", async () => {
    const leftOut = new Set<string>([
      ...SKILLS_CLI_COPY_EXCLUSIONS.anyName,
      ...SKILLS_CLI_COPY_EXCLUSIONS.directoryNames,
    ]);
    for (const { entry } of vendoredSkills()) {
      const source = entry.source;
      const names = await namesBelow(source);
      expect(names.filter((name) => leftOut.has(name))).toEqual([]);
      for (const name of names) {
        expect(name).not.toBe(".DS_Store");
      }
      expect((await lstat(source)).isSymbolicLink()).toBe(false);
    }
  });

  it("the fake backend's pinned stand-ins never appear among shipped fingerprints", () => {
    const shipped = new Set([
      ...Object.values(BUNDLE_FINGERPRINTS.history).flat(),
      ...Object.values(BUNDLE_FINGERPRINTS.pinned).flatMap((byName) =>
        Object.values(byName),
      ),
    ]);
    for (const entry of findSkillGroup("essentials")?.skills ?? []) {
      expect(shipped.has(fakePinnedSkillFingerprint(entry.skillName))).toBe(
        false,
      );
    }
  });
});

describe("skill tree caps", () => {
  it("refuses more than 200 entries even when some would be skipped", async () => {
    const directory = await createDirectory();
    await writeFile(join(directory, ".DS_Store"), "finder");
    for (let index = 0; index < 300; index += 1) {
      await writeFile(join(directory, `f${index}`), "x");
    }

    await expect(fingerprintInstalledSkill(directory)).rejects.toThrow(
      "it has more than 200 entries",
    );
  });
});
