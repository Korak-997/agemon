import { createReadStream, type Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { readRegularFileIfExists, writeFileAtomic } from "../core/files.js";
import {
  preparePrivateStateDirectory,
  repositoryStateKey,
} from "../core/state-root.js";
import { printable } from "../core/untrusted-text.js";

interface ModelPrices {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface TranscriptMessage {
  model: string;
  usage: MessageUsage;
  timestamp: string;
}

export interface SubagentUsage {
  agentType: string;
  model: string;
  costUsd: number;
  costAtSessionModelUsd: number;
}

export interface SessionUsage {
  sessionId: string;
  lastActivity: string;
  sessionModel: string;
  costUsd: number;
  unpricedMessages: number;
  subagents: SubagentUsage[];
}

export interface AgentTypeSummary {
  agentType: string;
  calls: number;
  costUsd: number;
  savingUsd: number;
}

export interface UsageSummary {
  sinceDays?: number;
  sessions: number;
  sessionsWithSubagents: number;
  subagentCalls: number;
  cheaperCalls: number;
  costUsd: number;
  costAtSessionModelUsd: number;
  estimatedSavingUsd: number;
  savingPercent: number;
  unpricedMessages: number;
  pricesCheckedOn: string;
  byAgentType: AgentTypeSummary[];
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const PRICES_CHECKED_ON = "2026-11-06";
const PRICES_BY_MODEL: Record<string, ModelPrices> = {
  "claude-fable-5-1": {
    input: 10,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 0.25,
    output: 50,
  },
  "claude-opus-5-5": {
    input: 4,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2,
    output: 20,
  },
  "claude-opus-4-8": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-sonnet-5-5": {
    input: 2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.1,
    output: 10,
  },
  "claude-haiku-5-5": {
    input: 0.1,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    output: 0.5,
  },
};
const LONG_PROMPT_THRESHOLD_TOKENS = 100_000;
const LONG_PROMPT_PRICES_BY_MODEL: Record<string, ModelPrices> = {
  "claude-haiku-5-5": {
    input: 0.5,
    cacheWrite5m: 0.625,
    cacheWrite1h: 1,
    cacheRead: 0.05,
    output: 2.5,
  },
};
const TRANSCRIPT_EXTENSION = ".jsonl";
const ASSISTANT_LINE_MARKER = '"assistant"';
const NON_API_MODEL_PREFIX = "<";
const UNKNOWN_AGENT_TYPE = "unknown";
const SINCE_PATTERN = /^([1-9]\d*)d$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const HISTORY_VERSION = 1;
const HISTORY_FILE_MODE = 0o600;

export function costOfMessage(
  model: string,
  usage: MessageUsage,
): number | null {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const prompt = input + cacheRead + cacheWrite;
  const prices =
    (prompt > LONG_PROMPT_THRESHOLD_TOKENS
      ? LONG_PROMPT_PRICES_BY_MODEL[model]
      : undefined) ?? PRICES_BY_MODEL[model];
  if (!prices) return null;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  return (
    (input * prices.input +
      cacheRead * prices.cacheRead +
      cacheWrite5m * prices.cacheWrite5m +
      cacheWrite1h * prices.cacheWrite1h +
      (usage.output_tokens ?? 0) * prices.output) /
    TOKENS_PER_PRICE_UNIT
  );
}

// Claude Code writes one line per content block, each repeating its message's id and usage.
async function readTranscriptMessages(
  file: string,
  seenMessageIds: Set<string>,
): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line.includes(ASSISTANT_LINE_MARKER)) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { id?: string; model?: string; usage?: MessageUsage };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, model, usage } = entry.message ?? {};
    if (entry.type !== "assistant" || !id || !model || !usage) continue;
    if (model.startsWith(NON_API_MODEL_PREFIX) || seenMessageIds.has(id)) {
      continue;
    }
    seenMessageIds.add(id);
    messages.push({ model, usage, timestamp: entry.timestamp ?? "" });
  }
  return messages;
}

function mostUsedModel(messages: TranscriptMessage[]): string | undefined {
  const counts = new Map<string, number>();
  for (const { model } of messages) {
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts].sort((first, second) => second[1] - first[1])[0]?.[0];
}

function pricedTotal(messages: TranscriptMessage[]): {
  costUsd: number;
  unpricedMessages: number;
} {
  let costUsd = 0;
  let unpricedMessages = 0;
  for (const { model, usage } of messages) {
    const cost = costOfMessage(model, usage);
    if (cost === null) unpricedMessages += 1;
    else costUsd += cost;
  }
  return { costUsd, unpricedMessages };
}

function costAtModel(messages: TranscriptMessage[], sessionModel: string) {
  return messages.reduce((total, { model, usage }) => {
    const actual = costOfMessage(model, usage);
    if (actual === null) return total;
    return total + (costOfMessage(sessionModel, usage) ?? actual);
  }, 0);
}

async function readEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readAgentType(transcript: string): Promise<string> {
  const metaFile = transcript.replace(/\.jsonl$/u, ".meta.json");
  try {
    const contents = await readRegularFileIfExists(metaFile);
    const agentType = contents && JSON.parse(contents).agentType;
    return typeof agentType === "string"
      ? printable(agentType)
      : UNKNOWN_AGENT_TYPE;
  } catch {
    return UNKNOWN_AGENT_TYPE;
  }
}

async function scanSession(
  projectDirectory: string,
  sessionId: string,
): Promise<SessionUsage | null> {
  const seenMessageIds = new Set<string>();
  const mainMessages = await readTranscriptMessages(
    join(projectDirectory, `${sessionId}${TRANSCRIPT_EXTENSION}`),
    seenMessageIds,
  );
  const sessionModel = mostUsedModel(mainMessages);
  if (!sessionModel) return null;

  const main = pricedTotal(mainMessages);
  let { costUsd, unpricedMessages } = main;
  let lastActivity = mainMessages.at(-1)?.timestamp ?? "";
  const subagents: SubagentUsage[] = [];
  const subagentsDirectory = join(projectDirectory, sessionId, "subagents");
  for (const entry of await readEntries(subagentsDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_EXTENSION)) continue;
    const file = join(subagentsDirectory, entry.name);
    const messages = await readTranscriptMessages(file, seenMessageIds);
    const model = mostUsedModel(messages);
    if (!model) continue;
    const total = pricedTotal(messages);
    costUsd += total.costUsd;
    unpricedMessages += total.unpricedMessages;
    const finishedAt = messages.at(-1)?.timestamp ?? "";
    if (finishedAt > lastActivity) lastActivity = finishedAt;
    subagents.push({
      agentType: await readAgentType(file),
      model,
      costUsd: total.costUsd,
      costAtSessionModelUsd: costAtModel(messages, sessionModel),
    });
  }
  return {
    sessionId,
    lastActivity,
    sessionModel,
    costUsd,
    unpricedMessages,
    subagents,
  };
}

export async function scanProjectSessions(
  projectDirectory: string,
): Promise<SessionUsage[]> {
  const sessions: SessionUsage[] = [];
  for (const entry of await readEntries(projectDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_EXTENSION)) continue;
    const session = await scanSession(
      projectDirectory,
      basename(entry.name, TRANSCRIPT_EXTENSION),
    );
    if (session) sessions.push(session);
  }
  return sessions;
}

export function mergeSessions(
  stored: SessionUsage[],
  fresh: SessionUsage[],
): SessionUsage[] {
  const bySessionId = new Map(
    [...stored, ...fresh].map((session) => [session.sessionId, session]),
  );
  return [...bySessionId.values()];
}

export function summarizeSessions(
  sessions: SessionUsage[],
  window: { sinceDays?: number; now?: Date } = {},
): UsageSummary {
  const { sinceDays, now = new Date() } = window;
  const included =
    sinceDays === undefined
      ? sessions
      : sessions.filter(
          ({ lastActivity }) =>
            new Date(lastActivity).getTime() >=
            now.getTime() - sinceDays * MILLISECONDS_PER_DAY,
        );
  const subagents = included.flatMap((session) => session.subagents);
  const costUsd = included.reduce((sum, { costUsd: cost }) => sum + cost, 0);
  const estimatedSavingUsd = subagents.reduce(
    (sum, subagent) => sum + subagent.costAtSessionModelUsd - subagent.costUsd,
    0,
  );
  const costAtSessionModelUsd = costUsd + estimatedSavingUsd;
  const byAgentType = new Map<string, AgentTypeSummary>();
  for (const subagent of subagents) {
    const summary = byAgentType.get(subagent.agentType) ?? {
      agentType: subagent.agentType,
      calls: 0,
      costUsd: 0,
      savingUsd: 0,
    };
    summary.calls += 1;
    summary.costUsd += subagent.costUsd;
    summary.savingUsd += subagent.costAtSessionModelUsd - subagent.costUsd;
    byAgentType.set(subagent.agentType, summary);
  }
  return {
    sinceDays,
    sessions: included.length,
    sessionsWithSubagents: included.filter(
      (session) => session.subagents.length > 0,
    ).length,
    subagentCalls: subagents.length,
    cheaperCalls: subagents.filter(
      (subagent) => subagent.costUsd < subagent.costAtSessionModelUsd,
    ).length,
    costUsd,
    costAtSessionModelUsd,
    estimatedSavingUsd,
    savingPercent:
      costAtSessionModelUsd > 0
        ? (estimatedSavingUsd / costAtSessionModelUsd) * 100
        : 0,
    unpricedMessages: included.reduce(
      (sum, session) => sum + session.unpricedMessages,
      0,
    ),
    pricesCheckedOn: PRICES_CHECKED_ON,
    byAgentType: [...byAgentType.values()].sort(
      (first, second) => second.calls - first.calls,
    ),
  };
}

function dollars(amount: number): string {
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

export function renderUsageReport(summary: UsageSummary): string {
  const period =
    summary.sinceDays === undefined
      ? "all saved history"
      : `active in the last ${summary.sinceDays} days`;
  const lines = [
    `Claude Code sessions in this repo, ${period}`,
    "",
    `Sessions: ${summary.sessions}, of which ${summary.sessionsWithSubagents} used subagents`,
    `Subagent calls: ${summary.subagentCalls}, of which ${summary.cheaperCalls} ran cheaper than the session's model`,
    ...summary.byAgentType.map(
      ({ agentType, calls, costUsd, savingUsd }) =>
        `  ${printable(agentType)}: ${calls} calls, cost ${dollars(costUsd)}, saving ${dollars(savingUsd)}`,
    ),
    "",
    `Actual cost:                               ${dollars(summary.costUsd)}`,
    `If subagents had used the session's model: ${dollars(summary.costAtSessionModelUsd)}`,
    `Estimated saving:                          ${dollars(summary.estimatedSavingUsd)} (${summary.savingPercent.toFixed(1)}%)`,
    "",
    `This is an estimate at API list prices checked on ${summary.pricesCheckedOn}, not a bill. It reprices the`,
    "same subagent tokens, so it does not show what doing the work inline would have cost, or",
    "whether the cheaper work was good enough.",
  ];
  if (summary.unpricedMessages > 0) {
    lines.push(
      "",
      `${summary.unpricedMessages} messages used a model with no known price and are left out.`,
    );
  }
  return lines.join("\n");
}

export function parseSinceDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = SINCE_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `--since must be a number of days such as 30d, got '${printable(value)}'.`,
    );
  }
  return Number(match[1]);
}

// Claude Code names each project's folder after its path, with every other character as a dash.
export async function claudeProjectDirectory(
  repoRoot: string,
): Promise<string> {
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const folder = (await realpath(repoRoot)).replace(/[^a-zA-Z0-9]/gu, "-");
  return join(configDirectory, "projects", folder);
}

async function readHistory(historyFile: string): Promise<SessionUsage[]> {
  const contents = await readRegularFileIfExists(historyFile);
  if (contents === null) return [];
  try {
    const { sessions } = JSON.parse(contents);
    if (Array.isArray(sessions)) return sessions;
  } catch {}
  throw new Error(
    `Cannot read the usage history at ${printable(historyFile)}. Fix or delete that file, then run agemon usage again.`,
  );
}

export async function loadUsageReport(
  repoRoot: string,
  window: { sinceDays?: number },
): Promise<{ summary: UsageSummary; historyFile: string }> {
  const historyDirectory = await preparePrivateStateDirectory("usage");
  const historyFile = join(
    historyDirectory,
    `${await repositoryStateKey(repoRoot)}.json`,
  );
  const stored = await readHistory(historyFile);
  const fresh = await scanProjectSessions(
    await claudeProjectDirectory(repoRoot),
  );
  const sessions = mergeSessions(stored, fresh);
  await writeFileAtomic(
    historyFile,
    `${JSON.stringify({ version: HISTORY_VERSION, sessions }, null, 2)}\n`,
    { newFileMode: HISTORY_FILE_MODE },
  );
  return { summary: summarizeSessions(sessions, window), historyFile };
}
