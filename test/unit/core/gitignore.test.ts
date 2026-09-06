import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgemonGitignoreEntry } from "../../../src/core/gitignore.js";

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
