import type { Context } from "../core/context.js";
import type { SharedResourceId } from "../core/machine-ledger.js";
import type { LedgerEntry } from "../core/state-manifest.js";

export interface PluginPresence {
  present: boolean;
  preExisting: boolean;
}

export interface PluginVerificationResult {
  ok: boolean;
  detail?: string;
  attention?: string;
}

export const RISK_CLASSES = [
  "inert",
  "writes-config",
  "executes",
  "credential-adjacent",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export const PROPOSED_OPERATION_ACTIONS = [
  "create",
  "merge-block",
  "merge-key",
  "adopt",
  "replace",
  "install-package",
  "register-service",
  "use-shared",
  "conflict",
  "skip",
] as const;

export type ProposedOperationAction =
  (typeof PROPOSED_OPERATION_ACTIONS)[number];

export const UNREADABLE_GIT_CONFIG_CATEGORIES = [
  "git-failed",
  "truncated",
  "malformed",
  "cap-reached",
  "not-a-regular-file",
] as const;

export type UnreadableGitConfigCategory =
  (typeof UNREADABLE_GIT_CONFIG_CATEGORIES)[number];

export type UntrustedGitConfig =
  | { kind: "pairs"; pairs: string[]; fingerprint: string }
  | { kind: "tooMany"; count: number; fingerprint: string }
  | { kind: "unshowable"; fingerprint: string }
  | { kind: "unreadable"; category: UnreadableGitConfigCategory };

export interface SkillUpdate {
  name: string;
  installedFingerprint: string;
  currentFingerprint: string;
}

export interface ProposedOperation {
  id: string;
  capabilityId: string;
  resourceId: string;
  targetPath: string;
  action: ProposedOperationAction;
  riskClass: RiskClass;
  requiresConsent: boolean;
  expectedFingerprint: string | null;
  preview: { kind: "diff" | "note"; text: string };
  untrustedGitConfig?: UntrustedGitConfig;
  updates?: SkillUpdate[];
}

export type StagedFileKind = "markdown" | "json" | "yaml" | "text";

export interface StagedFile {
  targetPath: string;
  contents: string;
  kind: StagedFileKind;
}

export type CapabilityState =
  | "present-managed"
  | "present-adopted"
  | "present-modified"
  | "absent"
  | "declined"
  | "unknown";

export interface CapabilityStateRow {
  capabilityId: string;
  resourceId: string;
  label: string;
  state: CapabilityState;
  detail: string | null;
}

export interface SharedResourceDeclaration {
  id: SharedResourceId;
  toolName: string;
  manualRemoveCommand: string;
  removalVerb: "uninstall" | "disable";
  migratesFromRepoLedgers: boolean;
}

export interface SkippedPluginOperation {
  operationId: string;
  reason: string;
}

export interface PluginApplyReport {
  skipped: SkippedPluginOperation[];
}

export interface AgemonPlugin {
  id: string;
  dependsOn?: string[];
  riskClass?: RiskClass;
  sharedResources?: SharedResourceDeclaration[];
  detect(ctx: Context): Promise<PluginPresence>;
  desiredRevision?(ctx: Context, resourceId: string): string | null;
  describeState?(ctx: Context): Promise<CapabilityStateRow[]>;
  plan?(
    ctx: Context,
    plannedSoFar?: readonly ProposedOperation[],
  ): Promise<ProposedOperation[]>;
  materialize?(
    ctx: Context,
    operations: ProposedOperation[],
  ): Promise<StagedFile[]>;
  apply?(
    ctx: Context,
    operations: ProposedOperation[],
    staged?: StagedFile[],
  ): Promise<PluginApplyReport | undefined>;
  install?(ctx: Context): Promise<void>;
  verify(ctx: Context): Promise<PluginVerificationResult>;
  revert?(ctx: Context, entries: LedgerEntry[]): Promise<void>;
  describeKeptAfterRollback?(
    ctx: Context,
    operations: ProposedOperation[],
  ): Promise<string[]>;
  uninstall(ctx: Context): Promise<void>;
}

export type PluginWithInstall = AgemonPlugin &
  Required<Pick<AgemonPlugin, "install">>;
