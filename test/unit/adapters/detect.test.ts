import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgents } from "../../../src/adapters/detect.js";
import { createAdapterTestContext } from "./context-fixture.js";
import { buildDiscoveryResult } from "./discovery-fixture.js";

const createdTempDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalFakeSubprocess = process.env.AGEMON_FAKE_SUBPROCESS;
const originalFakeInstalledAgents = process.env.AGEMON_FAKE_INSTALLED_AGENTS;
const originalFakeUsableAgents = process.env.AGEMON_FAKE_USABLE_AGENTS;

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
  process.env.PATH = originalPath;
  if (originalFakeSubprocess === undefined) {
    delete process.env.AGEMON_FAKE_SUBPROCESS;
  } else {
    process.env.AGEMON_FAKE_SUBPROCESS = originalFakeSubprocess;
  }
  if (originalFakeInstalledAgents === undefined) {
    delete process.env.AGEMON_FAKE_INSTALLED_AGENTS;
  } else {
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = originalFakeInstalledAgents;
  }
  if (originalFakeUsableAgents === undefined) {
    delete process.env.AGEMON_FAKE_USABLE_AGENTS;
  } else {
    process.env.AGEMON_FAKE_USABLE_AGENTS = originalFakeUsableAgents;
  }
});

async function createFakeBinDirectory(binaryNames: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-detect-bin-"));
  createdTempDirectories.push(directory);
  for (const binaryName of binaryNames) {
    const binaryPath = join(directory, binaryName);
    await writeFile(binaryPath, "#!/bin/sh\necho fake\n", "utf8");
    await chmod(binaryPath, 0o755);
  }
  return directory;
}

describe("detectAgents", () => {
  it("caps every row at configured and never calls ctx.run when consent is declined", async () => {
    const directory = await createFakeBinDirectory(["claude", "gemini"]);
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude,gemini";

    let runCallCount = 0;
    const context = await createAdapterTestContext({
      confirm: async () => false,
    });
    createdTempDirectories.push(context.cwd);
    const realRun = context.run;
    context.run = async (...args) => {
      runCallCount += 1;
      return realRun(...args);
    };

    const rows = await detectAgents(context, buildDiscoveryResult());

    expect(runCallCount).toBe(0);
    for (const row of rows) {
      expect(row.installation).toEqual({
        level: "configured",
        executablePath: null,
        version: null,
        evidence: [],
      });
    }
  });

  it("probes every adapter's installation once consent is granted", async () => {
    const directory = await createFakeBinDirectory(["claude", "gemini"]);
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude,gemini";

    const context = await createAdapterTestContext({
      confirm: async () => true,
    });
    createdTempDirectories.push(context.cwd);

    const rows = await detectAgents(context, buildDiscoveryResult());
    const byAdapterId = new Map(rows.map((row) => [row.adapterId, row]));

    expect(byAdapterId.get("claude-code")?.installation.level).toBe(
      "installed",
    );
    expect(byAdapterId.get("gemini-cli")?.installation.level).toBe("installed");
    expect(byAdapterId.get("copilot")?.installation.level).toBe("configured");
  });

  it("reports configured from discovery independently of the installation probe", async () => {
    const context = await createAdapterTestContext({
      confirm: async () => false,
    });
    createdTempDirectories.push(context.cwd);
    process.env.PATH = "";

    const discovery = buildDiscoveryResult({
      ruleFiles: [
        { kind: "rule-file", path: "CLAUDE.md", exists: true, contents: "" },
      ],
    });

    const rows = await detectAgents(context, discovery);
    const claudeRow = rows.find((row) => row.adapterId === "claude-code");

    expect(claudeRow?.configured).toBe(true);
    expect(
      claudeRow?.configuredResources.find(
        (resource) => resource.path === "CLAUDE.md",
      )?.exists,
    ).toBe(true);
  });

  it("never runs a usability probe unless checkUsable is explicitly passed", async () => {
    const directory = await createFakeBinDirectory(["claude", "gemini"]);
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude,gemini";
    process.env.AGEMON_FAKE_USABLE_AGENTS = "claude,gemini";

    const context = await createAdapterTestContext({
      confirm: async () => true,
    });
    createdTempDirectories.push(context.cwd);

    const rows = await detectAgents(context, buildDiscoveryResult());
    const byAdapterId = new Map(rows.map((row) => [row.adapterId, row]));

    expect(byAdapterId.get("claude-code")?.installation.level).toBe(
      "installed",
    );
    expect(byAdapterId.get("gemini-cli")?.installation.level).toBe("installed");
  });

  it("upgrades installed adapters to usable when checkUsable is true and the dry-run succeeds", async () => {
    const directory = await createFakeBinDirectory(["claude", "gemini"]);
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude,gemini";
    process.env.AGEMON_FAKE_USABLE_AGENTS = "claude,gemini";

    const context = await createAdapterTestContext({
      confirm: async () => true,
    });
    createdTempDirectories.push(context.cwd);

    const rows = await detectAgents(context, buildDiscoveryResult(), {
      checkUsable: true,
    });
    const byAdapterId = new Map(rows.map((row) => [row.adapterId, row]));

    expect(byAdapterId.get("claude-code")?.installation.level).toBe("usable");
    expect(byAdapterId.get("gemini-cli")?.installation.level).toBe("usable");
    expect(byAdapterId.get("copilot")?.installation.level).toBe("configured");
  });

  it("leaves an adapter at installed when checkUsable is true but the dry-run fails", async () => {
    const directory = await createFakeBinDirectory(["claude", "gemini"]);
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude,gemini";
    delete process.env.AGEMON_FAKE_USABLE_AGENTS;

    const context = await createAdapterTestContext({
      confirm: async () => true,
    });
    createdTempDirectories.push(context.cwd);

    const rows = await detectAgents(context, buildDiscoveryResult(), {
      checkUsable: true,
    });
    const byAdapterId = new Map(rows.map((row) => [row.adapterId, row]));

    expect(byAdapterId.get("claude-code")?.installation.level).toBe(
      "installed",
    );
    expect(
      byAdapterId
        .get("claude-code")
        ?.installation.evidence.some((line) =>
          line.includes("usability probe failed"),
        ),
    ).toBe(true);
  });
});
