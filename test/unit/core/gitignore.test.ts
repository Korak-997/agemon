import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureGitignoreEntry,
  gitIgnoresAgemonState,
  writeAgemonGitignoreEntry,
} from "../../../src/core/gitignore.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-gitignore-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

async function createGitRepository(): Promise<string> {
  const repository = await createSandbox();
  execFileSync("git", ["init", "-q", repository]);
  return repository;
}

describe("writeAgemonGitignoreEntry", () => {
  it("creates .gitignore with /.agemon/ when the file is missing", async () => {
    const cwd = await createSandbox();

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "/.agemon/\n",
    );
  });

  it("appends the entry after existing lines", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "dist\n", "utf8");

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "dist\n/.agemon/\n",
    );
  });

  it("appends /.agemon/ after a negation, and git then ignores .agemon/", async () => {
    const cwd = await createGitRepository();
    await writeFile(join(cwd, ".gitignore"), ".agemon\n!.agemon\n", "utf8");
    expect(await gitIgnoresAgemonState(cwd)).toEqual({ kind: "not-ignored" });

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      ".agemon\n!.agemon\n/.agemon/\n",
    );
    expect(await gitIgnoresAgemonState(cwd)).toEqual({ kind: "ignored" });
  });
});

describe("writeAgemonGitignoreEntry while git cannot confirm", () => {
  it("appends /.agemon/ only once across repeated runs", async () => {
    const cwd = await createSandbox();
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".gitignore"), "dist\n", "utf8");

    await writeAgemonGitignoreEntry(cwd);
    await writeAgemonGitignoreEntry(cwd);
    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "dist\n/.agemon/\n",
    );
  });

  it("does not append after a trailing comment when the last rule is already the entry", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), ".agemon\n# end\n\n", "utf8");

    await writeAgemonGitignoreEntry(cwd);

    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      ".agemon\n# end\n\n",
    );
  });
});

describe("gitIgnoresAgemonState", () => {
  it("asks git, so a later negation is not-ignored", async () => {
    const cwd = await createGitRepository();
    await writeFile(join(cwd, ".gitignore"), "/.agemon/\n", "utf8");
    expect(await gitIgnoresAgemonState(cwd)).toEqual({ kind: "ignored" });

    await writeFile(join(cwd, ".gitignore"), "/.agemon/\n!/.agemon/\n", "utf8");
    expect(await gitIgnoresAgemonState(cwd)).toEqual({ kind: "not-ignored" });
  });

  it("reports a directory without a .git entry as not a repository", async () => {
    const cwd = await createSandbox();

    expect(await gitIgnoresAgemonState(cwd)).toEqual({
      kind: "not-a-repository",
    });
  });

  it("reports a missing git binary outside a repository as not a repository", async () => {
    const cwd = await createSandbox();
    vi.stubEnv("PATH", await createSandbox());

    expect(await gitIgnoresAgemonState(cwd)).toEqual({
      kind: "not-a-repository",
    });
  });

  it("reports a git failure with a .git entry as failed, carrying git's message", async () => {
    const cwd = await createSandbox();
    await mkdir(join(cwd, ".git"));

    const verdict = await gitIgnoresAgemonState(cwd);

    expect(verdict.kind).toBe("failed");
    expect(verdict.kind === "failed" && verdict.detail).toMatch(/git/i);
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

describe("what the .gitignore writers report", () => {
  it("reports whether a line was added, whether the file existed and its previous contents", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, ".gitignore"), "dist", "utf8");

    const agemonLine = await writeAgemonGitignoreEntry(cwd);
    const agemonLineAgain = await writeAgemonGitignoreEntry(cwd);
    const lockLine = await ensureGitignoreEntry(cwd, "/skills-lock.json");
    const lockLineAgain = await ensureGitignoreEntry(cwd, "skills-lock.json");

    expect(agemonLine).toEqual({
      added: true,
      existedBefore: true,
      contentsBefore: "dist",
    });
    expect(agemonLineAgain.added).toBe(false);
    expect(lockLine).toEqual({
      added: true,
      existedBefore: true,
      contentsBefore: "dist\n/.agemon/\n",
    });
    expect(lockLineAgain.added).toBe(false);
  });

  it("reports a .gitignore it created", async () => {
    const cwd = await createSandbox();

    await expect(writeAgemonGitignoreEntry(cwd)).resolves.toEqual({
      added: true,
      existedBefore: false,
      contentsBefore: null,
    });
  });
});
