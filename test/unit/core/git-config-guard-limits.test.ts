import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const configListing = vi.hoisted(() => ({ stdout: "" }));

vi.mock("../../../src/core/subprocess-runner.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../src/core/subprocess-runner.js")
    >();
  return {
    ...original,
    runRealSubprocess: async (
      command: string,
      args: string[],
      options?: Parameters<typeof original.runRealSubprocess>[2],
    ) =>
      args.includes("--file")
        ? { code: 0, stdout: configListing.stdout, stderr: "" }
        : original.runRealSubprocess(command, args, options),
  };
});

const { findUntrustedGitConfig } = await import(
  "../../../src/core/git-config-guard.js"
);
const { TRUNCATION_MARKER } = await import(
  "../../../src/core/subprocess-runner.js"
);

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "agemon-git-guard-limits-"));
  createdTempDirectories.push(repository);
  execFileSync("git", ["init", "-q", repository]);
  return repository;
}

describe("findUntrustedGitConfig — listing limits", () => {
  it("refuses a listing that ends in the capture truncation marker", async () => {
    configListing.stdout = `core.bare\nfalse\0${TRUNCATION_MARKER}`;

    expect(
      await findUntrustedGitConfig(await createRepository()),
    ).toMatchObject({ kind: "unreadable", category: "truncated" });
  });

  it("refuses a listing whose last record has no terminator", async () => {
    configListing.stdout = "core.bare\nfalse\0core.filemode\ntrue";

    expect(
      await findUntrustedGitConfig(await createRepository()),
    ).toMatchObject({ kind: "unreadable", category: "malformed" });
  });

  it("refuses a record without a key", async () => {
    configListing.stdout = "\nvalue\0";

    expect(
      await findUntrustedGitConfig(await createRepository()),
    ).toMatchObject({ kind: "unreadable", category: "malformed" });
  });
});
