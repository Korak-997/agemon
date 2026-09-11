import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { copilotAdapter } from "../../../src/adapters/copilot.js";
import { createAdapterTestContext } from "./context-fixture.js";
import { buildDiscoveryResult } from "./discovery-fixture.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("copilotAdapter.discoverProjectResources", () => {
  it("reports no resources when nothing is configured", () => {
    expect(
      copilotAdapter.discoverProjectResources(buildDiscoveryResult()),
    ).toEqual([]);
  });

  it("surfaces root and scoped Copilot instruction files", () => {
    const discovery = buildDiscoveryResult({
      copilotInstructions: [
        {
          kind: "copilot-instruction",
          path: ".github/copilot-instructions.md",
          exists: true,
        },
        {
          kind: "copilot-instruction",
          path: ".github/instructions/api.instructions.md",
          exists: true,
        },
      ],
    });

    const resources = copilotAdapter.discoverProjectResources(discovery);

    expect(resources.map((resource) => resource.path)).toEqual([
      ".github/copilot-instructions.md",
      ".github/instructions/api.instructions.md",
    ]);
    expect(resources.every((resource) => resource.exists)).toBe(true);
  });
});

describe("copilotAdapter.detectInstallation", () => {
  it("always reports the configured level — Copilot has no standalone executable to probe", async () => {
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);

    const evidence = await copilotAdapter.detectInstallation(context);

    expect(evidence.level).toBe("configured");
    expect(evidence.executablePath).toBeNull();
    expect(evidence.version).toBeNull();
  });
});
