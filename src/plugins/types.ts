import type { Context } from "../core/context.js";

export interface PluginPresence {
  present: boolean;
  preExisting: boolean;
}

export interface PluginVerificationResult {
  ok: boolean;
  detail?: string;
}

export interface AgemonPlugin {
  id: string;
  dependsOn?: string[];
  detect(ctx: Context): Promise<PluginPresence>;
  install(ctx: Context): Promise<void>;
  verify(ctx: Context): Promise<PluginVerificationResult>;
  uninstall(ctx: Context): Promise<void>;
}
