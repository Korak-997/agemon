import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface RecordedListing {
  args: string[];
  cwd: string | undefined;
  ceiling: string | undefined;
  noLazyFetch: string | undefined;
  allowProtocol: string | undefined;
}

const listings = vi.hoisted(() => [] as RecordedListing[]);

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
    ) => {
      if (args.includes("--file") || args.includes("--blob")) {
        listings.push({
          args,
          cwd: options?.cwd,
          ceiling: options?.env?.GIT_CEILING_DIRECTORIES,
          noLazyFetch: options?.env?.GIT_NO_LAZY_FETCH,
          allowProtocol: options?.env?.GIT_ALLOW_PROTOCOL,
        });
      }
      return original.runRealSubprocess(command, args, options);
    },
  };
});

const { findUntrustedGitConfig } = await import(
  "../../../src/core/git-config-guard.js"
);

const createdTempDirectories: string[] = [];

afterEach(async () => {
  listings.length = 0;
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("findUntrustedGitConfig — where its listings run", () => {
  it("runs file and blob listings outside every repository, with no git transport", async () => {
    const repository = await realpath(
      await mkdtemp(join(tmpdir(), "agemon-guard-isolation-")),
    );
    createdTempDirectories.push(repository);
    execFileSync("git", ["init", "-q", repository]);
    await writeFile(join(repository, ".gitmodules"), '[submodule "x"]\n');
    execFileSync("git", ["-C", repository, "add", ".gitmodules"]);
    await rm(join(repository, ".gitmodules"));

    await findUntrustedGitConfig(repository);

    expect(listings.some(({ args }) => args.includes("--file"))).toBe(true);
    expect(listings.some(({ args }) => args.includes("--blob"))).toBe(true);
    for (const listing of listings) {
      expect(listing.cwd).toBeDefined();
      expect(listing.cwd).toBe(listing.ceiling);
      expect(relative(repository, listing.cwd as string).startsWith("..")).toBe(
        true,
      );
      expect(listing.noLazyFetch).toBe("1");
      expect(listing.allowProtocol).toBe("");
    }
  });
});
