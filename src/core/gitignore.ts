import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITIGNORE_FILENAME = ".gitignore";
const AGEMON_ENTRY = "/.agemon/";
const AGEMON_ENTRY_NORMALIZED = ".agemon";

function normalizeIgnoreLine(line: string): string {
  return line.trim().replace(/^\//, "").replace(/\/$/, "");
}

export function gitignoreListsAgemon(contents: string): boolean {
  return contents
    .split(/\r?\n/)
    .some((line) => normalizeIgnoreLine(line) === AGEMON_ENTRY_NORMALIZED);
}

export async function writeAgemonGitignoreEntry(cwd: string): Promise<void> {
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
    await writeFile(gitignorePath, `${AGEMON_ENTRY}\n`, "utf8");
    return;
  }

  if (gitignoreListsAgemon(contents)) {
    return;
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    contents.length === 0 || contents.endsWith("\n") ? "" : newline;
  await writeFile(
    gitignorePath,
    `${contents}${separator}${AGEMON_ENTRY}${newline}`,
    "utf8",
  );
}
