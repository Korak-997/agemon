import type { Context } from "../core/context.js";
import type { LedgerEntry } from "../core/state-manifest.js";

export interface PluginPresence {
  present: boolean;
  preExisting: boolean;
}

export interface PluginVerificationResult {
  ok: boolean;
  detail?: string;
}

export type RiskClass =
  | "inert"
  | "writes-config"
  | "executes"
  | "credential-adjacent";

export type ProposedOperationAction =
  | "create"
  | "merge-block"
  | "merge-key"
  | "adopt"
  | "replace"
  | "install-package"
  | "register-service"
  | "conflict"
  | "skip";

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
}

export type StagedFileKind = "markdown" | "json" | "yaml" | "text";

export interface StagedFile {
  targetPath: string;
  contents: string;
  kind: StagedFileKind;
}

export interface AgemonPlugin {
  id: string;
  dependsOn?: string[];
  riskClass?: RiskClass;
  detect(ctx: Context): Promise<PluginPresence>;
  desiredRevision?(ctx: Context, resourceId: string): string | null;
  plan?(ctx: Context): Promise<ProposedOperation[]>;
  materialize?(
    ctx: Context,
    operations: ProposedOperation[],
  ): Promise<StagedFile[]>;
  apply?(
    ctx: Context,
    operations: ProposedOperation[],
    staged?: StagedFile[],
  ): Promise<void>;
  install(ctx: Context): Promise<void>;
  verify(ctx: Context): Promise<PluginVerificationResult>;
  revert?(ctx: Context, entries: LedgerEntry[]): Promise<void>;
  uninstall(ctx: Context): Promise<void>;
}
