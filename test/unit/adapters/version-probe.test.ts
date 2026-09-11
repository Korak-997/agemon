import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInstallationEvidence } from "../../../src/adapters/types.js";
import {
  probeAgentInstallation,
  probeAgentUsability,
  resolveExecutableAbsolutePath,
} from "../../../src/adapters/version-probe.js";
import { createAdapterTestContext } from "./context-fixture.js";

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

async function createFakeExecutable(binaryName: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agemon-fake-bin-"));
  createdTempDirectories.push(directory);
  const binaryPath = join(directory, binaryName);
  await writeFile(binaryPath, "#!/bin/sh\necho fake\n", "utf8");
  await chmod(binaryPath, 0o755);
  return directory;
}

describe("resolveExecutableAbsolutePath", () => {
  it("returns the absolute path of the first PATH entry containing the binary", async () => {
    const directory = await createFakeExecutable("claude");

    const resolved = await resolveExecutableAbsolutePath("claude", directory);

    expect(resolved).toBe(join(directory, "claude"));
  });

  it("skips PATH entries that don't contain the binary", async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), "agemon-empty-bin-"));
    createdTempDirectories.push(emptyDirectory);
    const realDirectory = await createFakeExecutable("gemini");

    const resolved = await resolveExecutableAbsolutePath(
      "gemini",
      [emptyDirectory, realDirectory].join(delimiter),
    );

    expect(resolved).toBe(join(realDirectory, "gemini"));
  });

  it("returns undefined when the binary is nowhere on PATH", async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), "agemon-empty-bin-"));
    createdTempDirectories.push(emptyDirectory);

    const resolved = await resolveExecutableAbsolutePath(
      "claude",
      emptyDirectory,
    );

    expect(resolved).toBeUndefined();
  });
});

describe("probeAgentInstallation", () => {
  it("reports configured-only when the binary is not on PATH", async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), "agemon-empty-bin-"));
    createdTempDirectories.push(emptyDirectory);
    process.env.PATH = emptyDirectory;
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);

    const evidence = await probeAgentInstallation(context, {
      binaryName: "claude",
      versionArgs: ["--version"],
      parseVersion: (stdout) => stdout.trim() || null,
      timeoutMs: 1000,
    });

    expect(evidence).toEqual({
      level: "configured",
      executablePath: null,
      version: null,
      evidence: [],
    });
  });

  it("reports installed with the resolved path and version via the fake subprocess backend", async () => {
    const directory = await createFakeExecutable("claude");
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_INSTALLED_AGENTS = "claude";
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);

    const evidence = await probeAgentInstallation(context, {
      binaryName: "claude",
      versionArgs: ["--version"],
      parseVersion: (stdout) => /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null,
      timeoutMs: 1000,
    });

    expect(evidence.level).toBe("installed");
    expect(evidence.executablePath).toBe(join(directory, "claude"));
    expect(evidence.version).toBe("1.0.0");
  });

  it("stays at configured when the resolved binary's output doesn't parse as a version", async () => {
    const directory = await createFakeExecutable("claude");
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    delete process.env.AGEMON_FAKE_INSTALLED_AGENTS;
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);

    const evidence = await probeAgentInstallation(context, {
      binaryName: "claude",
      versionArgs: ["--version"],
      parseVersion: (stdout) => /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null,
      timeoutMs: 1000,
    });

    expect(evidence.level).toBe("configured");
    expect(evidence.executablePath).toBe(join(directory, "claude"));
    expect(evidence.version).toBeNull();
  });

  it("stays at configured and records the failure when the probe times out", async () => {
    const directory = await createFakeExecutable("claude");
    process.env.PATH = directory;
    delete process.env.AGEMON_FAKE_SUBPROCESS;
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);
    context.run = async () => ({
      code: 124,
      stdout: "",
      stderr: "Command timed out after 1000ms.",
    });

    const evidence = await probeAgentInstallation(context, {
      binaryName: "claude",
      versionArgs: ["--version"],
      parseVersion: (stdout) => /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null,
      timeoutMs: 1000,
    });

    expect(evidence.level).toBe("configured");
    expect(evidence.version).toBeNull();
    expect(evidence.evidence.some((line) => line.includes("exit 124"))).toBe(
      true,
    );
  });
});

describe("probeAgentUsability", () => {
  const installedEvidence = (
    executablePath: string,
  ): AgentInstallationEvidence => ({
    level: "installed",
    executablePath,
    version: "1.0.0-fake",
    evidence: [
      `resolved claude at ${executablePath}`,
      "reported version 1.0.0-fake",
    ],
  });

  it("returns the evidence unchanged when the adapter isn't installed", async () => {
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);
    const configuredOnly: AgentInstallationEvidence = {
      level: "configured",
      executablePath: null,
      version: null,
      evidence: [],
    };

    const evidence = await probeAgentUsability(context, configuredOnly, {
      usabilityArgs: ["doctor"],
      timeoutMs: 1000,
    });

    expect(evidence).toBe(configuredOnly);
  });

  it("upgrades to usable when the dry-run probe succeeds", async () => {
    const directory = await createFakeExecutable("claude");
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    process.env.AGEMON_FAKE_USABLE_AGENTS = "claude";
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);
    const executablePath = join(directory, "claude");

    const evidence = await probeAgentUsability(
      context,
      installedEvidence(executablePath),
      { usabilityArgs: ["doctor"], timeoutMs: 1000 },
    );

    expect(evidence.level).toBe("usable");
    expect(evidence.evidence.some((line) => line.includes("succeeded"))).toBe(
      true,
    );
  });

  it("stays at installed and records the failure when the dry-run probe exits non-zero", async () => {
    const directory = await createFakeExecutable("claude");
    process.env.PATH = directory;
    process.env.AGEMON_FAKE_SUBPROCESS = "1";
    delete process.env.AGEMON_FAKE_USABLE_AGENTS;
    const context = await createAdapterTestContext();
    createdTempDirectories.push(context.cwd);
    const executablePath = join(directory, "claude");

    const evidence = await probeAgentUsability(
      context,
      installedEvidence(executablePath),
      { usabilityArgs: ["doctor"], timeoutMs: 1000 },
    );

    expect(evidence.level).toBe("installed");
    expect(
      evidence.evidence.some((line) => line.includes("usability probe failed")),
    ).toBe(true);
  });
});
