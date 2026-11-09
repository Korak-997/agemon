import { multiselect } from "@clack/prompts";
import { readIsolationStatus } from "../inspect/discover.js";
import type { AgemonPlugin, Offer } from "../plugins/types.js";
import {
  type AgemonConfig,
  type ConfigCapabilityUpdate,
  rewriteConfigCapabilities,
} from "./config.js";
import type { RunOutcome } from "./orchestrator.js";
import { assertNotCancelled } from "./prompt-clack.js";

const CAPABILITIES_BEFORE_KNOWN_LIST: readonly string[] = [
  "crg",
  "daemon",
  "skills",
  "cli-tool",
  "master-prompt",
];

const OUTCOMES_THAT_UPDATE_CONFIG: ReadonlySet<RunOutcome> = new Set([
  "applied",
  "nothing-to-do",
  "partial",
  "declined",
]);

export function findCapabilityOffers(
  config: AgemonConfig,
  plugins: AgemonPlugin[],
): Offer[] {
  const knownIds = new Set(
    config.knownCapabilities ?? CAPABILITIES_BEFORE_KNOWN_LIST,
  );
  const listedIds = new Set(config.capabilities);
  return plugins
    .filter(
      (plugin) =>
        !listedIds.has(plugin.id) &&
        (plugin.dependsOn ?? []).every((dependencyId) =>
          listedIds.has(dependencyId),
        ),
    )
    .map((plugin) => ({
      kind: "capability",
      id: plugin.id,
      state: knownIds.has(plugin.id) ? "declined" : "new",
    }));
}

export async function promptForNewCapabilities(
  newCapabilities: AgemonPlugin[],
): Promise<string[]> {
  return assertNotCancelled(
    await multiselect<string>({
      message: "New capabilities to add",
      options: newCapabilities.map((plugin) => ({
        value: plugin.id,
        label: plugin.id,
        hint: plugin.summary,
      })),
      required: false,
      initialValues: [],
    }),
  );
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
