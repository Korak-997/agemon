import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { StateManifest } from "../../../src/core/state-manifest.js";
import type { SubprocessResult } from "../../../src/core/subprocess-runner.js";
import { crgPlugin } from "../../../src/plugins/crg/index.js";
import { CODE_REVIEW_GRAPH_VERSION } from "../../../src/plugins/pins.js";

const PINNED_SPEC = `code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`;
const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createTestContext() {
  const cwd = await mkdtemp(join(tmpdir(), "agemon-crg-test-"));
  createdTempDirectories.push(cwd);
  const run = vi.fn(
    async (command: string): Promise<SubprocessResult> =>
      command === "code-review-graph"
        ? { code: 127, stdout: "", stderr: "not found" }
        : { code: 0, stdout: "", stderr: "" },
  );
  const context = {
    cwd,
    dryRun: false,
    run,
    manifest: await StateManifest.load(cwd),
    ui: { start() {}, succeed() {}, fail() {}, info() {} },
  } as unknown as Context;
  return { context, run };
}

function pipxCalls(run: ReturnType<typeof vi.fn>): string[][] {
  return run.mock.calls
    .filter(([command]) => command === "pipx")
    .map(([, args]) => args as string[]);
}

describe("crg plugin pins", () => {
  it("previews the pinned install", async () => {
    const { context } = await createTestContext();

    const [operation] = (await crgPlugin.plan?.(context)) ?? [];

    expect(operation?.preview).toEqual({
      kind: "note",
      text: `pipx install ${PINNED_SPEC}; build the code graph for this repository`,
    });
  });

  it("installs and runs the pinned version, and uninstalls by name", async () => {
    const { context, run } = await createTestContext();

    await crgPlugin.install(context);
    await crgPlugin.verify(context);
    await crgPlugin.uninstall(context);

    expect(pipxCalls(run)).toEqual([
      ["install", PINNED_SPEC],
      ["run", "--spec", PINNED_SPEC, "code-review-graph", "build"],
      ["run", "--spec", PINNED_SPEC, "code-review-graph", "status"],
      ["uninstall", "code-review-graph"],
    ]);
  });
});
