import { join } from "node:path";
import { readRegularFileIfExists, writeFileAtomic } from "./files.js";

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

  const contents = await readRegularFileIfExists(gitignorePath);

  if (contents === null) {
    await writeFileAtomic(gitignorePath, `${entry}\n`);
    return;
  }

  if (gitignoreListsEntry(contents, entry)) {
    return;
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    contents.length === 0 || contents.endsWith("\n") ? "" : newline;
  await writeFileAtomic(
    gitignorePath,
    `${contents}${separator}${entry}${newline}`,
  );
}

export async function writeAgemonGitignoreEntry(cwd: string): Promise<void> {
  await ensureGitignoreEntry(cwd, AGEMON_ENTRY);
}
