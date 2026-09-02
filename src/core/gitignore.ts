import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITIGNORE_FILENAME = ".gitignore";
const AGEMON_ENTRY = ".agemon";

export async function ensureAgemonGitignored(
  cwd: string,
  dryRun: boolean,
): Promise<boolean> {
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);
  let contents: string;

  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (contents.split(/\r?\n/).some((line) => line.trim() === AGEMON_ENTRY)) {
    return false;
  }

  if (!dryRun) {
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    const separator = contents.endsWith("\n") ? "" : newline;
    await writeFile(
      gitignorePath,
      `${contents}${separator}${AGEMON_ENTRY}${newline}`,
      "utf8",
    );
  }

  return true;
}
