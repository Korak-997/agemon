import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGitignoreEntry,
  writeAgemonGitignoreEntry,
} from "../../../src/core/gitignore.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-gitignore-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("writeAgemonGitignoreEntry", () => {
  it("creates .gitignore with /.agemon/ when the file is missing", async () => {
    const cwd = await createSandbox();

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "/.agemon/\n",
    );
  });

  it("appends the entry once and is idempotent on a re-run", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "dist\n", "utf8");

    await writeAgemonGitignoreEntry(cwd);
    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "dist\n/.agemon/\n",
    );
  });

  it("leaves an existing .agemon entry untouched regardless of slash style", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "node_modules\n.agemon\n", "utf8");

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "node_modules\n.agemon\n",
    );
  });
});

describe("ensureGitignoreEntry", () => {
  it("creates .gitignore with the entry when the file is missing", async () => {
    const cwd = await createSandbox();

    await ensureGitignoreEntry(cwd, "/skills-lock.json");

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "/skills-lock.json\n",
    );
  });

  it("appends the entry once and is idempotent on a re-run", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "/.agemon/\n", "utf8");

    await ensureGitignoreEntry(cwd, "/skills-lock.json");
    await ensureGitignoreEntry(cwd, "/skills-lock.json");

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "/.agemon/\n/skills-lock.json\n",
    );
  });

  it("adds a trailing newline before appending when the file lacks one", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "dist", "utf8");

    await ensureGitignoreEntry(cwd, "/skills-lock.json");

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "dist\n/skills-lock.json\n",
    );
  });

  it("leaves an existing entry untouched regardless of leading slash", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "skills-lock.json\n", "utf8");

    await ensureGitignoreEntry(cwd, "/skills-lock.json");

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "skills-lock.json\n",
    );
  });
});
