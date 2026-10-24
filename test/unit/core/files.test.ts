import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTooLargeError,
  MAX_READ_FILE_BYTES,
  NotARegularFileError,
  RefusedFileError,
  readRegularFileIfExists,
  saveVerifiedCopyBeside,
  writeFileAtomic,
} from "../../../src/core/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const runningAsRoot = process.getuid?.() === 0;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await chmod(directoryPath, 0o700).catch(() => undefined);
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-files-test-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

function currentUmask(): number {
  return Number.parseInt(
    execFileSync("sh", ["-c", "umask"], { encoding: "utf8" }).trim(),
    8,
  );
}

describe("readRegularFileIfExists", () => {
  it("reads a regular file and returns null for a missing one", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "a.md"), "hello\n", "utf8");

    await expect(readRegularFileIfExists(join(cwd, "a.md"))).resolves.toBe(
      "hello\n",
    );
    await expect(
      readRegularFileIfExists(join(cwd, "missing.md")),
    ).resolves.toBe(null);
  });

  it("refuses a symlink without reading its target", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "real.md"), "real\n", "utf8");
    await symlink(join(cwd, "real.md"), join(cwd, "CLAUDE.md"));

    await expect(
      readRegularFileIfExists(join(cwd, "CLAUDE.md")),
    ).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(runningAsRoot)(
    "throws EACCES for an unreadable file instead of treating it as absent",
    async () => {
      const cwd = await createSandbox();
      const unreadable = join(cwd, "CLAUDE.md");
      await writeFile(unreadable, "secret\n", "utf8");
      await chmod(unreadable, 0o000);

      await expect(readRegularFileIfExists(unreadable)).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it("refuses a file larger than the read cap", async () => {
    const cwd = await createSandbox();
    await writeFile(
      join(cwd, "AGENTS.md"),
      "x".repeat(MAX_READ_FILE_BYTES + 1),
    );

    await expect(
      readRegularFileIfExists(join(cwd, "AGENTS.md")),
    ).rejects.toThrow(FileTooLargeError);
  });

  it("reads a file of exactly the read cap", async () => {
    const cwd = await createSandbox();
    await writeFile(join(cwd, "AGENTS.md"), "x".repeat(MAX_READ_FILE_BYTES));

    await expect(
      readRegularFileIfExists(join(cwd, "AGENTS.md")),
    ).resolves.toHaveLength(MAX_READ_FILE_BYTES);
  });

  it("groups every refusal under RefusedFileError", () => {
    expect(new NotARegularFileError("read", "/x")).toBeInstanceOf(
      RefusedFileError,
    );
    expect(new FileTooLargeError("/x")).toBeInstanceOf(RefusedFileError);
  });

  it("refuses a FIFO without blocking", async () => {
    const cwd = await createSandbox();
    execFileSync("mkfifo", [join(cwd, "pipe.md")]);

    await expect(readRegularFileIfExists(join(cwd, "pipe.md"))).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe("writeFileAtomic", () => {
  it("replaces an existing file and keeps its mode", async () => {
    const cwd = await createSandbox();
    const target = join(cwd, "AGENTS.md");
    await writeFile(target, "old\n", "utf8");
    await chmod(target, 0o640);

    await writeFileAtomic(target, "new\n");

    await expect(readFile(target, "utf8")).resolves.toBe("new\n");
    expect((await stat(target)).mode & 0o7777).toBe(0o640);
  });

  it("creates a new file with the umask-derived mode, not 0600", async () => {
    const cwd = await createSandbox();
    const target = join(cwd, ".gitignore");

    await writeFileAtomic(target, "/.agemon/\n");

    await expect(readFile(target, "utf8")).resolves.toBe("/.agemon/\n");
    expect((await stat(target)).mode & 0o7777).toBe(0o666 & ~currentUmask());
  });

  it("refuses to write through a symlink and leaves link and target unchanged", async () => {
    const cwd = await createSandbox();
    const outside = await createSandbox();
    const linkTarget = join(outside, "elsewhere.md");
    await writeFile(linkTarget, "outside\n", "utf8");
    const link = join(cwd, "CLAUDE.md");
    await symlink(linkTarget, link);

    await expect(writeFileAtomic(link, "pointer\n")).rejects.toThrow(
      /not a regular file/,
    );

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(linkTarget);
    await expect(readFile(linkTarget, "utf8")).resolves.toBe("outside\n");
  });

  it("refuses to replace a FIFO", async () => {
    const cwd = await createSandbox();
    const fifo = join(cwd, "AGENTS.md");
    execFileSync("mkfifo", [fifo]);

    await expect(writeFileAtomic(fifo, "x\n")).rejects.toThrow(
      /not a regular file/,
    );
    expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  it.skipIf(runningAsRoot)("refuses to replace a read-only file", async () => {
    const cwd = await createSandbox();
    const target = join(cwd, "CLAUDE.md");
    await writeFile(target, "protected\n", "utf8");
    await chmod(target, 0o444);

    await expect(writeFileAtomic(target, "x\n")).rejects.toThrow(/read-only/);
    await expect(readFile(target, "utf8")).resolves.toBe("protected\n");
  });

  it("leaves the old contents and no temp file when the rename fails", async () => {
    const cwd = await createSandbox();
    const target = join(cwd, "AGENTS.md");
    await writeFile(target, "old\n", "utf8");
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(
      new Error("simulated crash before rename"),
    );

    await expect(writeFileAtomic(target, "new\n")).rejects.toThrow(
      /simulated crash/,
    );

    await expect(readFile(target, "utf8")).resolves.toBe("old\n");
    expect(await readdir(cwd)).toEqual(["AGENTS.md"]);
  });
});

describe("writeFileAtomic newFileMode", () => {
  it("applies the requested mode to a new file and keeps an existing file's mode", async () => {
    const directory = await createSandbox();
    const created = join(directory, "new.json");
    const existing = join(directory, "existing.json");
    await writeFile(existing, "old", { mode: 0o644 });

    await writeFileAtomic(created, "new", { newFileMode: 0o600 });
    await writeFileAtomic(existing, "new", { newFileMode: 0o600 });

    expect((await stat(created)).mode & 0o777).toBe(0o600);
    expect((await stat(existing)).mode & 0o777).toBe(0o644);
  });
});

describe("saveVerifiedCopyBeside", () => {
  it("writes <target>.agemon-original, falling back to a timestamped name when taken", async () => {
    const directory = await createSandbox();
    const target = join(directory, "AGENTS.md");

    const first = await saveVerifiedCopyBeside(target, "first\n");
    const second = await saveVerifiedCopyBeside(target, "second\n");

    expect(first).toBe(`${target}.agemon-original`);
    expect(second).toMatch(/AGENTS\.md\.agemon-original\.\d+$/);
    await expect(readFile(first, "utf8")).resolves.toBe("first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("second\n");
    expect((await stat(first)).mode & 0o777).toBe(0o600);
  });
});
