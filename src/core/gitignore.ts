import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITIGNORE_FILENAME = ".gitignore";
const AGEMON_ENTRY = "/.agemon/";

function normalizeIgnoreLine(line: string): string {
  return line.trim().replace(/^\//, "").replace(/\/$/, "");
}

function gitignoreListsEntry(contents: string, entry: string): boolean {
  const normalizedEntry = normalizeIgnoreLine(entry);
  return contents
    .split(/\r?\n/)
    .some((line) => normalizeIgnoreLine(line) === normalizedEntry);
}

export async function ensureGitignoreEntry(
  cwd: string,
  entry: string,
): Promise<void> {
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);

  let contents: string | null;
  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    contents = null;
  }

  if (contents === null) {
    await writeFile(gitignorePath, `${entry}\n`, "utf8");
    return;
  }

  if (gitignoreListsEntry(contents, entry)) {
    return;
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    contents.length === 0 || contents.endsWith("\n") ? "" : newline;
  await writeFile(
    gitignorePath,
    `${contents}${separator}${entry}${newline}`,
    "utf8",
  );
}

export async function writeAgemonGitignoreEntry(cwd: string): Promise<void> {
  await ensureGitignoreEntry(cwd, AGEMON_ENTRY);
}
