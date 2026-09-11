import { claudeCodeAdapter } from "./claude-code.js";
import { copilotAdapter } from "./copilot.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import type { AgentAdapter } from "./types.js";

const adapterRegistry: AgentAdapter[] = [
  claudeCodeAdapter,
  geminiCliAdapter,
  copilotAdapter,
];

export function getRegisteredAdapters(): AgentAdapter[] {
  return adapterRegistry;
}
