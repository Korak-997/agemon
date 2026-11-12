import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN_THREAD_EXPLORATION_BUDGET = 12;
const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob"]);
const DELEGATION_TOOL = "Agent";
const TOP_TIER_MODEL = "opus";
const TURN_ON_ARGUMENT = "on";
const CHAT_KEY_LENGTH = 16;
const CHAT_KEY_PATTERN = new RegExp(`^[0-9a-f]{${CHAT_KEY_LENGTH}}$`, "u");
const GUARD_COMMAND = `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/agemon-delegation-guard.mjs"`;
const SWITCH_VARIABLE = "AGEMON_GUARD";
const EXPLORATION_DENIAL = `agemon delegation guard: this prompt already used ${MAIN_THREAD_EXPLORATION_BUDGET} searches in the main conversation. Delegate the rest of the exploration with the Agent tool (subagent_type "Explore") and ask for a short report. Set ${SWITCH_VARIABLE}=off to disable.`;
const TOP_TIER_DENIAL = `agemon delegation guard: subagents do not run on ${TOP_TIER_MODEL} in this chat. Pass model "haiku" for searching or "sonnet" for other work. Set ${SWITCH_VARIABLE}=off to disable.`;

function offerFor(chatKey) {
  return [
    "agemon delegation guard is installed but off in this chat.",
    "Before you start on the user's first request, ask them once, in one short question:",
    `"Turn on the agemon delegation guard for this chat? It allows ${MAIN_THREAD_EXPLORATION_BUDGET} file searches per message in the main conversation, then hands further searching to the cheaper Explore agent."`,
    `If they say yes, run \`${GUARD_COMMAND} ${TURN_ON_ARGUMENT} ${chatKey}\`. If they say no, carry on and do not ask again in this chat.`,
  ].join("\n");
}

function chatKeyOf(sessionId) {
  return createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, CHAT_KEY_LENGTH);
}

function statePathOf(chatKey) {
  return join(tmpdir(), `agemon-guard-${chatKey}.json`);
}

function readState(chatKey) {
  try {
    const state = JSON.parse(readFileSync(statePathOf(chatKey), "utf8"));
    return {
      enabled: state.enabled === true,
      count: Number.isInteger(state.count) ? state.count : 0,
    };
  } catch {
    return { enabled: false, count: 0 };
  }
}

function writeState(chatKey, state) {
  writeFileSync(statePathOf(chatKey), JSON.stringify(state), { mode: 0o600 });
}

function respond(hookSpecificOutput) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

function deny(reason) {
  respond({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  });
}

function turnOn(chatKey) {
  if (!CHAT_KEY_PATTERN.test(chatKey ?? "")) {
    return;
  }
  writeState(chatKey, { enabled: true, count: 0 });
  process.stdout.write("agemon delegation guard is on for this chat.\n");
}

function handlePreToolUse(payload, chatKey, state) {
  if (payload.agent_id !== undefined) {
    return;
  }
  if (payload.tool_name === DELEGATION_TOOL) {
    if (payload.tool_input?.model === TOP_TIER_MODEL) {
      deny(TOP_TIER_DENIAL);
    }
    return;
  }
  if (!EXPLORATION_TOOLS.has(payload.tool_name)) {
    return;
  }
  const count = state.count + 1;
  writeState(chatKey, { ...state, count });
  if (count > MAIN_THREAD_EXPLORATION_BUDGET) {
    deny(EXPLORATION_DENIAL);
  }
}

function handleHookEvent(payload) {
  if (typeof payload?.session_id !== "string") {
    return;
  }
  const chatKey = chatKeyOf(payload.session_id);
  const turnedOnByEnvironment = process.env[SWITCH_VARIABLE] === "on";
  if (payload.hook_event_name === "SessionStart") {
    if (!turnedOnByEnvironment) {
      respond({
        hookEventName: "SessionStart",
        additionalContext: offerFor(chatKey),
      });
    }
    return;
  }
  const state = readState(chatKey);
  if (!state.enabled && !turnedOnByEnvironment) {
    return;
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    writeState(chatKey, { ...state, count: 0 });
  } else if (payload.hook_event_name === "PreToolUse") {
    handlePreToolUse(payload, chatKey, state);
  }
}

try {
  if (process.env[SWITCH_VARIABLE] !== "off") {
    const [command, chatKey] = process.argv.slice(2);
    if (command === TURN_ON_ARGUMENT) {
      turnOn(chatKey);
    } else if (command === undefined) {
      handleHookEvent(JSON.parse(readFileSync(0, "utf8")));
    }
  }
} catch {}
