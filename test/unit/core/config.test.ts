import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      /keep-mine.*skip|skip.*keep-mine/,
    );
  });

  it("fails closed when capabilities is not an array of strings", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "agemon.toml"), "capabilities = 3\n", "utf8");

    await expect(loadConfig(cwd)).rejects.toThrow(/capabilities/);
  });
});
