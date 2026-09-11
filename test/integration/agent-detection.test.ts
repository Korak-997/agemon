import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CaptureNonInteractiveRunOptions,
  captureNonInteractiveRun,
  parseJsonOutput,
} from "./cli-harness.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

interface AgentSummary {
  adapterId: string;
  configured: boolean;
  level: string;
}

function summarizeAgents(agents: unknown): AgentSummary[] {
  return (
    agents as Array<{
      adapterId: string;
      configured: boolean;
      installation: { level: string };
    }>
  ).map((row) => ({
    adapterId: row.adapterId,
    configured: row.configured,
    level: row.installation.level,
  }));
}

async function inspectAgentSummaries(
  fixtureName: string,
  argv: string[],
  options?: CaptureNonInteractiveRunOptions,
): Promise<AgentSummary[]> {
  const sandboxDirectory = await mkdtemp(
    join(tmpdir(), "agemon-agent-detection-"),
  );
  createdTempDirectories.push(sandboxDirectory);

  const output = await captureNonInteractiveRun(
    fixtureName,
    ["inspect", "--json", ...argv],
    sandboxDirectory,
    options,
  );

  const report = parseJsonOutput(output) as { agents: unknown };
  return summarizeAgents(report.agents);
}

describe("agent detection wired into `agemon inspect --json`", () => {
  it("reports every ecosystem unconfigured and unprobed for no-agents-installed", async () => {
    expect(
      await inspectAgentSummaries("no-agents-installed", ["--yes"], {
        extraBinaryNames: ["claude", "gemini"],
      }),
    ).toEqual([
      { adapterId: "claude-code", configured: false, level: "configured" },
      { adapterId: "gemini-cli", configured: false, level: "configured" },
      { adapterId: "copilot", configured: false, level: "configured" },
    ]);
  });

  it("reports Claude Code installed when it is configured, on PATH, and consent is granted", async () => {
    expect(
      await inspectAgentSummaries("claude-code-only", ["--yes"], {
        extraBinaryNames: ["claude", "gemini"],
        env: { AGEMON_FAKE_INSTALLED_AGENTS: "claude" },
      }),
    ).toEqual([
      { adapterId: "claude-code", configured: true, level: "installed" },
      { adapterId: "gemini-cli", configured: false, level: "configured" },
      { adapterId: "copilot", configured: false, level: "configured" },
    ]);
  });

  it("reports Claude Code and Gemini CLI installed, and Copilot configured, for all-agents-configured-and-installed", async () => {
    expect(
      await inspectAgentSummaries(
        "all-agents-configured-and-installed",
        ["--yes"],
        {
          extraBinaryNames: ["claude", "gemini"],
          env: { AGEMON_FAKE_INSTALLED_AGENTS: "claude,gemini" },
        },
      ),
    ).toEqual([
      { adapterId: "claude-code", configured: true, level: "installed" },
      { adapterId: "gemini-cli", configured: true, level: "installed" },
      { adapterId: "copilot", configured: true, level: "configured" },
    ]);
  });

  it("stays capped at configured when a resolved binary reports an unparseable version", async () => {
    expect(
      await inspectAgentSummaries("agent-on-path-but-unversioned", ["--yes"], {
        extraBinaryNames: ["claude", "gemini"],
      }),
    ).toEqual([
      { adapterId: "claude-code", configured: true, level: "configured" },
      { adapterId: "gemini-cli", configured: false, level: "configured" },
      { adapterId: "copilot", configured: false, level: "configured" },
    ]);
  });

  it("declining the probe-agent-installations prompt caps every row at configured, even with a real binary on PATH", async () => {
    expect(
      await inspectAgentSummaries("claude-code-only", [], {
        extraBinaryNames: ["claude", "gemini"],
        env: { AGEMON_FAKE_INSTALLED_AGENTS: "claude" },
      }),
    ).toEqual([
      { adapterId: "claude-code", configured: true, level: "configured" },
      { adapterId: "gemini-cli", configured: false, level: "configured" },
      { adapterId: "copilot", configured: false, level: "configured" },
    ]);
  });
});
