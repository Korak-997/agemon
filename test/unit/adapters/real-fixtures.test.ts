import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegisteredAdapters } from "../../../src/adapters/index.js";
import { discoverRepository } from "../../../src/inspect/discover.js";
import { createAdapterTestContext } from "./context-fixture.js";

const fixturesRoot = join(process.cwd(), "test/fixtures");
const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function loadFixtureContext(fixtureName: string) {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-adapter-fixture-"),
  );
  createdTempDirectories.push(sandboxDirectory);
  const repoDirectory = join(sandboxDirectory, "repo");
  await cp(join(fixturesRoot, fixtureName), repoDirectory, {
    recursive: true,
  });

  const context = await createAdapterTestContext({ cwd: repoDirectory });
  let runCallCount = 0;
  context.run = async () => {
    runCallCount += 1;
    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    context,
    getRunCallCount: () => runCallCount,
  };
}

describe("adapter configured-level classification against real fixture directories", () => {
  it("classifies every adapter as unconfigured for no-agents-installed", async () => {
    const { context, getRunCallCount } = await loadFixtureContext(
      "no-agents-installed",
    );
    const discovery = await discoverRepository(context);

    const configuredByAdapter = Object.fromEntries(
      getRegisteredAdapters().map((adapter) => [
        adapter.id,
        adapter
          .discoverProjectResources(discovery)
          .some((resource) => resource.exists),
      ]),
    );

    expect(configuredByAdapter).toEqual({
      "claude-code": false,
      "gemini-cli": false,
      copilot: false,
    });
    expect(getRunCallCount()).toBe(0);
  });

  it("classifies only Claude Code as configured for claude-code-only", async () => {
    const { context, getRunCallCount } =
      await loadFixtureContext("claude-code-only");
    const discovery = await discoverRepository(context);

    const configuredByAdapter = Object.fromEntries(
      getRegisteredAdapters().map((adapter) => [
        adapter.id,
        adapter
          .discoverProjectResources(discovery)
          .some((resource) => resource.exists),
      ]),
    );

    expect(configuredByAdapter).toEqual({
      "claude-code": true,
      "gemini-cli": false,
      copilot: false,
    });
    expect(getRunCallCount()).toBe(0);
  });
});
