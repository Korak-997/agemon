import type { Context } from "../core/context.js";

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

export interface AgemonPlugin {
  id: string;
  dependsOn?: string[];
  riskClass?: RiskClass;
  detect(ctx: Context): Promise<PluginPresence>;
  plan?(ctx: Context): Promise<ProposedOperation[]>;
  install(ctx: Context): Promise<void>;
  verify(ctx: Context): Promise<PluginVerificationResult>;
  uninstall(ctx: Context): Promise<void>;
}
