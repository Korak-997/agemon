import { execFileSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

const GIT_BINARY = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

export async function linkGitInto(binDirectory: string): Promise<void> {
  await symlink(GIT_BINARY, join(binDirectory, "git"));
}
