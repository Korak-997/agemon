import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeProjectDirectory,
  costOfMessage,
  loadUsageReport,
  mergeSessions,
  parseSinceDays,
  renderUsageReport,
  type SessionUsage,
  scanProjectSessions,
  summarizeSessions,
} from "../../../src/inspect/usage.js";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

function usage(input: number, output: number, cacheRead = 0, write1h = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: write1h,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: write1h,
    },
  };
}

function assistantLine(
  id: string,
  model: string,
  tokens: ReturnType<typeof usage>,
  timestamp = "2026-11-06T10:00:00.000Z",
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    message: { id, model, usage: tokens, content: [] },
  })}\n`;
}

describe("usage report", () => {
  let root: string;
  let projectDirectory: string;

  async function writeSubagent(
    sessionId: string,
    agentId: string,
    lines: string,
    agentType?: string,
  ): Promise<void> {
    const folder = join(projectDirectory, sessionId, "subagents");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `agent-${agentId}.jsonl`), lines);
    if (agentType) {
      await writeFile(
        join(folder, `agent-${agentId}.meta.json`),
        JSON.stringify({
          agentType,
          description: "SECRET task description",
        }),
      );
    }
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agemon-usage-")));
    projectDirectory = join(root, "project");
    await mkdir(projectDirectory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  describe("costOfMessage", () => {
    it("matches a cost the CLI reported for Opus 5.5", () => {
      const cost = costOfMessage(OPUS, usage(8, 1412, 35617, 16257));
      expect(cost).toBeCloseTo(0.1654514, 7);
    });

    it("matches a cost the CLI reported for Haiku 5.5", () => {
      expect(costOfMessage(HAIKU, usage(1182, 20))).toBeCloseTo(0.0001282, 7);
    });

    it("charges Haiku's higher rates when the whole prompt is over 100K tokens", () => {
      const justUnder = costOfMessage(HAIKU, usage(0, 0, 100_000));
      const justOver = costOfMessage(HAIKU, usage(1, 0, 100_000));
      expect(justUnder).toBeCloseTo(0.001, 6);
      expect(justOver).toBeCloseTo(0.005, 5);
    });

    it("prices a 5-minute cache write differently from a 1-hour one", () => {
      const fiveMinutes = {
        ...usage(0, 0),
        cache_creation_input_tokens: 1_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 0,
        },
      };
      expect(costOfMessage(SONNET, fiveMinutes)).toBeCloseTo(2.5);
    });

    it("returns null for a model it has no price for", () => {
      expect(costOfMessage("claude-future-9", usage(1, 1))).toBeNull();
    });
  });

  describe("scanProjectSessions", () => {
    it("counts a message repeated across lines once", async () => {
      const line = assistantLine("m1", OPUS, usage(1_000_000, 0));
      await writeFile(join(projectDirectory, "s1.jsonl"), line + line + line);
      const [session] = await scanProjectSessions(projectDirectory);
      expect(session.costUsd).toBeCloseTo(4);
    });

    it("reprices a cheaper subagent's tokens at the session's model", async () => {
      await writeFile(
        join(projectDirectory, "s1.jsonl"),
        assistantLine("m1", OPUS, usage(1_000_000, 0)),
      );
      await writeSubagent(
        "s1",
        "a",
        assistantLine("m2", HAIKU, usage(1_000, 1_000)),
        "agemon-scout",
      );
      const [session] = await scanProjectSessions(projectDirectory);
      expect(session.sessionModel).toBe(OPUS);
      expect(session.subagents).toHaveLength(1);
      expect(session.subagents[0].agentType).toBe("agemon-scout");
      expect(session.subagents[0].model).toBe(HAIKU);
      expect(session.subagents[0].costUsd).toBeCloseTo(0.0006);
      expect(session.subagents[0].costAtSessionModelUsd).toBeCloseTo(0.024);
      expect(session.costUsd).toBeCloseTo(4.0006);
    });

    it("gives a subagent on a dearer model a negative saving", async () => {
      await writeFile(
        join(projectDirectory, "s1.jsonl"),
        assistantLine("m1", HAIKU, usage(1, 1)),
      );
      await writeSubagent(
        "s1",
        "a",
        assistantLine("m2", SONNET, usage(1000, 0)),
      );
      const [session] = await scanProjectSessions(projectDirectory);
      const [subagent] = session.subagents;
      expect(subagent.costUsd).toBeGreaterThan(subagent.costAtSessionModelUsd);
      expect(subagent.agentType).toBe("unknown");
    });

    it("stores numbers and agent types, never prompts or task descriptions", async () => {
      await writeFile(
        join(projectDirectory, "s1.jsonl"),
        assistantLine("m1", OPUS, usage(1, 1)),
      );
      await writeSubagent(
        "s1",
        "a",
        assistantLine("m2", OPUS, usage(1, 1)),
        "x",
      );
      const sessions = await scanProjectSessions(projectDirectory);
      expect(JSON.stringify(sessions)).not.toContain("SECRET");
    });

    it("counts messages it cannot price, and leaves them out of the cost", async () => {
      await writeFile(
        join(projectDirectory, "s1.jsonl"),
        assistantLine("m1", OPUS, usage(1_000_000, 0)) +
          assistantLine("m2", "claude-future-9", usage(1_000_000, 0)),
      );
      const [session] = await scanProjectSessions(projectDirectory);
      expect(session.unpricedMessages).toBe(1);
      expect(session.costUsd).toBeCloseTo(4);
    });

    it("skips unreadable lines and <synthetic> messages", async () => {
      await writeFile(
        join(projectDirectory, "s1.jsonl"),
        `not json "type":"assistant"\n${assistantLine("m1", OPUS, usage(1_000_000, 0))}${assistantLine("m2", "<synthetic>", usage(0, 0))}`,
      );
      const [session] = await scanProjectSessions(projectDirectory);
      expect(session.costUsd).toBeCloseTo(4);
      expect(session.unpricedMessages).toBe(0);
    });

    it("returns nothing for a project with no saved sessions", async () => {
      expect(await scanProjectSessions(join(root, "missing"))).toEqual([]);
    });
  });

  describe("summaries", () => {
    const session = (
      id: string,
      lastActivity: string,
      subagents: SessionUsage["subagents"] = [],
    ): SessionUsage => ({
      sessionId: id,
      lastActivity,
      sessionModel: OPUS,
      costUsd: 10,
      unpricedMessages: 0,
      subagents,
    });

    it("keeps a stored session whose transcript has gone, and refreshes the rest", () => {
      const stored = [
        session("old", "2026-01-01"),
        session("both", "2026-02-01"),
      ];
      const fresh = [{ ...session("both", "2026-03-01"), costUsd: 99 }];
      const merged = mergeSessions(stored, fresh);
      expect(merged.map((entry) => entry.sessionId).sort()).toEqual([
        "both",
        "old",
      ]);
      expect(merged.find((entry) => entry.sessionId === "both")?.costUsd).toBe(
        99,
      );
    });

    it("adds up the saving against what the session's model would have cost", () => {
      const summary = summarizeSessions([
        session("s1", "2026-11-01", [
          {
            agentType: "agemon-scout",
            model: HAIKU,
            costUsd: 1,
            costAtSessionModelUsd: 6,
          },
          {
            agentType: "general-purpose",
            model: OPUS,
            costUsd: 2,
            costAtSessionModelUsd: 2,
          },
        ]),
        session("s2", "2026-11-02"),
      ]);
      expect(summary.sessions).toBe(2);
      expect(summary.sessionsWithSubagents).toBe(1);
      expect(summary.subagentCalls).toBe(2);
      expect(summary.cheaperCalls).toBe(1);
      expect(summary.costUsd).toBe(20);
      expect(summary.costAtSessionModelUsd).toBe(25);
      expect(summary.estimatedSavingUsd).toBe(5);
      expect(summary.savingPercent).toBeCloseTo(20);
      expect(summary.byAgentType[0]).toMatchObject({
        agentType: "agemon-scout",
        calls: 1,
        savingUsd: 5,
      });
    });

    it("filters to sessions active within the window", () => {
      const summary = summarizeSessions(
        [session("recent", "2026-11-05"), session("old", "2026-01-01")],
        { sinceDays: 30, now: new Date("2026-11-06") },
      );
      expect(summary.sessions).toBe(1);
    });

    it("says plainly that the figure is an estimate, and when no subagent ran", () => {
      const text = renderUsageReport(
        summarizeSessions([session("s", "2026-11-05")]),
      );
      expect(text).toContain("Subagent calls: 0");
      expect(text).toContain("estimate");
      expect(text).toContain("list prices");
    });

    it("replaces control characters in agent type names", () => {
      const text = renderUsageReport(
        summarizeSessions([
          session("s", "2026-11-05", [
            {
              agentType: "evil\u001b[31m",
              model: OPUS,
              costUsd: 1,
              costAtSessionModelUsd: 1,
            },
          ]),
        ]),
      );
      expect(text).not.toContain("\u001b");
    });
  });

  describe("parseSinceDays", () => {
    it("accepts a whole number of days", () => {
      expect(parseSinceDays("30d")).toBe(30);
      expect(parseSinceDays(undefined)).toBeUndefined();
    });

    it.each(["30", "0d", "-1d", "1w", "d"])("rejects %s", (value) => {
      expect(() => parseSinceDays(value)).toThrow(/--since/);
    });
  });

  describe("loadUsageReport", () => {
    let repo: string;

    beforeEach(async () => {
      repo = join(root, "my.repo");
      await mkdir(repo);
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
      vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    });

    it("finds the repo's sessions the way Claude Code names its folders", async () => {
      expect(await claudeProjectDirectory(repo)).toBe(
        join(root, "claude", "projects", repo.replace(/[^a-zA-Z0-9]/gu, "-")),
      );
    });

    it("saves history so sessions survive their transcripts being deleted", async () => {
      const folder = await claudeProjectDirectory(repo);
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "s1.jsonl"),
        assistantLine("m1", OPUS, usage(1_000_000, 0)),
      );
      const first = await loadUsageReport(repo, {});
      expect(first.summary.sessions).toBe(1);

      await rm(folder, { recursive: true });
      const second = await loadUsageReport(repo, {});
      expect(second.summary.sessions).toBe(1);
      expect(second.summary.costUsd).toBeCloseTo(4);
      const saved = await readFile(second.historyFile, "utf8");
      expect(JSON.parse(saved).sessions[0].sessionId).toBe("s1");
    });

    it("refuses to overwrite a history file it cannot read", async () => {
      const { historyFile } = await loadUsageReport(repo, {});
      await writeFile(historyFile, "{broken");
      await expect(loadUsageReport(repo, {})).rejects.toThrow(/usage history/);
      expect(await readFile(historyFile, "utf8")).toBe("{broken");
    });
  });
});
