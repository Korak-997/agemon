import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureNonInteractiveRun } from "./cli-harness.js";

const CLI_TIMEOUT_MS = 20_000;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createSandbox(): Promise<string> {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), "agemon-recover-cli-"));
  createdTempDirectories.push(sandboxDirectory);
  return sandboxDirectory;
}

describe("recover and plan-id CLI contract", {
  timeout: CLI_TIMEOUT_MS,
}, () => {
  it("documents --yes, --dry-run and the recovery limit in recover --help", async () => {
    const output = await captureNonInteractiveRun(
      "clean-repo",
      ["recover", "--help"],
      await createSandbox(),
    );

    expect(output).toMatch(/^exit 0/);
    expect(output).toContain("--yes");
    expect(output).toContain("--dry-run");
    expect(output).toContain(
      "Check 'agemon status' for tools the interrupted apply may have installed.",
    );
  });

  it("says there is nothing to recover when no apply was interrupted", async () => {
    const output = await captureNonInteractiveRun(
      "clean-repo",
      ["recover"],
      await createSandbox(),
    );

    expect(output).toMatch(/^exit 0/);
    expect(output).toContain("Nothing to recover.");
  });

  it("refuses an invalid --plan id before creating any state", async () => {
    const sandboxDirectory = await createSandbox();

    const output = await captureNonInteractiveRun(
      "clean-repo",
      ["apply", "--plan", "../x"],
      sandboxDirectory,
    );

    expect(output).toMatch(/^exit 1/);
    expect(output).toContain("Invalid plan id '../x': expected 16 lowercase");
    expect(await readdir(join(sandboxDirectory, "repo"))).not.toContain(
      ".agemon",
    );
  });
});
