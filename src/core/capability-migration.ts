import { readIsolationStatus } from "../inspect/discover.js";
import type { AgemonPlugin } from "../plugins/types.js";
import {
  type AgemonConfig,
  type ConfigCapabilityUpdate,
  rewriteConfigCapabilities,
} from "./config.js";
import type { RunOutcome } from "./orchestrator.js";

const CAPABILITIES_BEFORE_KNOWN_LIST: readonly string[] = [
  "crg",
  "daemon",
  "skills",
  "cli-tool",
  "master-prompt",
];

const AUTO_ADDED_TO_EXISTING_CONFIGS: readonly string[] = ["agents"];

const OUTCOMES_THAT_UPDATE_CONFIG: ReadonlySet<RunOutcome> = new Set([
  "applied",
  "nothing-to-do",
  "partial",
  "declined",
]);

export function capabilitiesToAutoAdd(
  config: AgemonConfig,
  plugins: AgemonPlugin[],
): string[] {
  const knownIds = new Set(
    config.knownCapabilities ?? CAPABILITIES_BEFORE_KNOWN_LIST,
  );
  const listedIds = new Set(config.capabilities);
  return AUTO_ADDED_TO_EXISTING_CONFIGS.filter((id) => {
    const plugin = plugins.find((candidate) => candidate.id === id);
    return (
      plugin !== undefined &&
      !knownIds.has(id) &&
      !listedIds.has(id) &&
      (plugin.dependsOn ?? []).every((dependencyId) =>
        listedIds.has(dependencyId),
      )
    );
  });
}

export type AddedCapabilitiesUpdate =
  | ConfigCapabilityUpdate
  | { kind: "state-not-ignored" };

export async function addCapabilitiesToConfig(
  repoRoot: string,
  config: AgemonConfig,
  addedCapabilityIds: string[],
  options: { knownCapabilities: string[]; allowUnignoredState: boolean },
): Promise<AddedCapabilitiesUpdate> {
  if (
    !options.allowUnignoredState &&
    (await readIsolationStatus(repoRoot)) !== "ignored"
  ) {
    return { kind: "state-not-ignored" };
  }
  return rewriteConfigCapabilities(repoRoot, config, {
    capabilities: [...config.capabilities, ...addedCapabilityIds],
    knownCapabilities: options.knownCapabilities,
  });
}

export function outcomeUpdatesConfig(outcome: RunOutcome): boolean {
  return OUTCOMES_THAT_UPDATE_CONFIG.has(outcome);
}
