import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD_SCRIPT = resolve("assets/hooks/agemon-delegation-guard.mjs");
const SESSION_ID = "8f0c2a5e-3b1d-4c7e-9a62-0d4e5f6a7b8c";
const CHAT_KEY = createHash("sha256")
  .update(SESSION_ID)
  .digest("hex")
  .slice(0, 16);
const BUDGET = 12;

let stateDirectory: string;

beforeEach(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), "agemon-guard-test-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

function runGuard(
  options: { input?: string; args?: string[]; guard?: string } = {},
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: stateDirectory,
  };
  delete environment.AGEMON_GUARD;
  if (options.guard !== undefined) {
    environment.AGEMON_GUARD = options.guard;
  }
  const result = spawnSync(
    process.execPath,
    [GUARD_SCRIPT, ...(options.args ?? [])],
    { input: options.input ?? "", env: environment, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout };
}

function hookEvent(payload: Record<string, unknown>, guard?: string) {
  return runGuard({
    input: JSON.stringify({ session_id: SESSION_ID, ...payload }),
    guard,
  });
}

function preToolUse(toolName: string, extra: Record<string, unknown> = {}) {
  return hookEvent({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: {},
    ...extra,
  });
}

function turnOn() {
  return runGuard({ args: ["on", CHAT_KEY] });
}

function decisionOf(stdout: string): string | undefined {
  return stdout === ""
    ? undefined
    : JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

describe("agemon-delegation-guard hook", () => {
  it("exits 0 silently on empty stdin, invalid JSON, and an unknown event", () => {
    for (const input of [
      "",
      "{not json",
      JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Stop" }),
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read" }),
    ]) {
      expect(runGuard({ input })).toEqual({ status: 0, stdout: "" });
    }
  });

  it("exits 0 silently on a Copilot-shaped preToolUse payload", () => {
    const copilotPayload = JSON.stringify({
      timestamp: 1762905600000,
      cwd: "/repo",
      toolName: "view",
      toolArgs: '{"path":"README.md"}',
    });
    expect(runGuard({ input: copilotPayload })).toEqual({
      status: 0,
      stdout: "",
    });
  });

  it("stays off in a chat until it is turned on", () => {
    for (let call = 0; call <= BUDGET + 1; call += 1) {
      expect(preToolUse("Read")).toEqual({ status: 0, stdout: "" });
    }
  });

  it("SessionStart asks Claude to offer the guard, naming this chat's key", () => {
    const { status, stdout } = hookEvent({
      hook_event_name: "SessionStart",
      source: "startup",
    });

    expect(status).toBe(0);
    const output = JSON.parse(stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toContain(
      `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/agemon-delegation-guard.mjs" on ${CHAT_KEY}`,
    );
    expect(hookEvent({ hook_event_name: "SessionStart" }, "on").stdout).toBe(
      "",
    );
  });

  it("denies the 13th main-thread search and allows the 12th", () => {
    expect(turnOn()).toMatchObject({ status: 0 });
    for (let call = 1; call <= BUDGET; call += 1) {
      expect(decisionOf(preToolUse(call % 2 ? "Read" : "Grep").stdout)).toBe(
        undefined,
      );
    }
    const denied = preToolUse("Glob");
    expect(denied.status).toBe(0);
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain(
      'subagent_type "Explore"',
    );
  });

  it("never counts or denies when agent_id is present", () => {
    turnOn();
    for (let call = 0; call <= BUDGET + 1; call += 1) {
      expect(preToolUse("Read", { agent_id: "agent-1" }).stdout).toBe("");
    }
    expect(decisionOf(preToolUse("Read").stdout)).toBe(undefined);
    expect(
      preToolUse("Agent", {
        agent_id: "agent-1",
        tool_input: { model: "opus" },
      }).stdout,
    ).toBe("");
  });

  it("UserPromptSubmit resets the count", () => {
    turnOn();
    for (let call = 0; call < BUDGET; call += 1) {
      preToolUse("Read");
    }
    expect(hookEvent({ hook_event_name: "UserPromptSubmit" })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(decisionOf(preToolUse("Read").stdout)).toBe(undefined);
  });

  it("denies a main-thread Agent call that requests opus", () => {
    turnOn();
    expect(
      decisionOf(preToolUse("Agent", { tool_input: { model: "opus" } }).stdout),
    ).toBe("deny");
    expect(
      decisionOf(
        preToolUse("Agent", { tool_input: { model: "haiku" } }).stdout,
      ),
    ).toBe(undefined);
  });

  it("AGEMON_GUARD=on turns it on without asking", () => {
    for (let call = 0; call < BUDGET; call += 1) {
      hookEvent(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
        "on",
      );
    }
    const denied = hookEvent(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
      "on",
    );
    expect(decisionOf(denied.stdout)).toBe("deny");
  });

  it("AGEMON_GUARD=off disables denial", () => {
    turnOn();
    for (let call = 0; call <= BUDGET + 1; call += 1) {
      expect(
        hookEvent(
          { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
          "off",
        ),
      ).toEqual({ status: 0, stdout: "" });
    }
  });

  it("ignores an on command whose chat key is malformed", () => {
    expect(runGuard({ args: ["on", "../../etc/passwd"] })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(preToolUse("Read").stdout).toBe("");
  });
});
