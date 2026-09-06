import { fingerprintContent } from "../core/fingerprint.js";
import type { LedgerEntry } from "../core/state-manifest.js";
import type {
  CopilotInstructionResource,
  DiscoveryResult,
  RuleFileResource,
  StructuredConfigResource,
} from "./discover.js";

export type ResourceState =
  | "absent"
  | "equivalent"
  | "managed-current"
  | "managed-drifted"
  | "mergeable"
  | "conflict"
  | "unmanaged"
  | "invalid";

export interface ClassifiedResource {
  resourceId: string;
  path: string;
  kind: string;
  state: ResourceState;
  detail: string | null;
}

const CANONICAL_RULE_FILE = "AGENTS.md";
const POINTER_REFERENCE_PATTERN = /AGENTS\.md/i;
const POINTER_MAX_NORMALIZED_LENGTH = 800;

function ledgerEntryForResource(
  entries: LedgerEntry[],
  resourceId: string,
): LedgerEntry | undefined {
  return entries.find((entry) => entry.resourceId === resourceId);
}

function classifyManagedByFingerprint(
  entry: LedgerEntry,
  currentContents: string,
): ResourceState {
  if (
    entry.fingerprintAfter !== null &&
    entry.fingerprintAfter === fingerprintContent(currentContents)
  ) {
    return "managed-current";
  }
  return "managed-drifted";
}

function looksLikePointerFile(contents: string): boolean {
  if (!POINTER_REFERENCE_PATTERN.test(contents)) {
    return false;
  }
  return (
    contents.replace(/\s+/g, " ").trim().length <= POINTER_MAX_NORMALIZED_LENGTH
  );
}

function classifyRuleFile(
  resource: RuleFileResource,
  ledgerEntries: LedgerEntry[],
): ClassifiedResource {
  const resourceId = `rule-file:${resource.path}`;

  if (!resource.exists || resource.contents === null) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: "absent",
      detail: null,
    };
  }

  const entry = ledgerEntryForResource(ledgerEntries, resourceId);
  if (entry !== undefined) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: classifyManagedByFingerprint(entry, resource.contents),
      detail: entry.ownershipMode,
    };
  }

  if (
    resource.path !== CANONICAL_RULE_FILE &&
    looksLikePointerFile(resource.contents)
  ) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: "equivalent",
      detail: `points to ${CANONICAL_RULE_FILE}`,
    };
  }

  return {
    resourceId,
    path: resource.path,
    kind: resource.kind,
    state: "unmanaged",
    detail: null,
  };
}

function classifyStructuredConfig(
  resource: StructuredConfigResource,
): ClassifiedResource {
  const resourceId = `structured-config:${resource.path}`;

  if (resource.denylisted) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: "unmanaged",
      detail: "excluded: private local config",
    };
  }

  if (!resource.exists) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: "absent",
      detail: null,
    };
  }

  if (resource.parseError !== null) {
    return {
      resourceId,
      path: resource.path,
      kind: resource.kind,
      state: "invalid",
      detail: resource.parseError,
    };
  }

  return {
    resourceId,
    path: resource.path,
    kind: resource.kind,
    state: "unmanaged",
    detail: null,
  };
}

function classifyCopilotInstruction(
  resource: CopilotInstructionResource,
): ClassifiedResource {
  return {
    resourceId: `copilot-instruction:${resource.path}`,
    path: resource.path,
    kind: resource.kind,
    state: "unmanaged",
    detail: null,
  };
}

export function classifyResources(
  discovery: DiscoveryResult,
  ledgerEntries: LedgerEntry[],
): ClassifiedResource[] {
  return [
    ...discovery.ruleFiles.map((resource) =>
      classifyRuleFile(resource, ledgerEntries),
    ),
    ...discovery.structuredConfigs.map(classifyStructuredConfig),
    ...discovery.copilotInstructions.map(classifyCopilotInstruction),
  ];
}
