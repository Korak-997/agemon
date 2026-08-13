import type { StepSpinner } from "../ui/spinner.js";
import { StateManifest } from "./state-manifest.js";

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Context {
  cwd: string;
  os: "ubuntu";
  dryRun: boolean;
  yes: boolean;
  log: Pick<Console, "log" | "error">;
  ui: StepSpinner;
  run: (command: string, args: string[]) => Promise<SubprocessResult>;
  manifest: StateManifest;
}

export interface CreateContextInput {
  dryRun: boolean;
  yes: boolean;
  ui: StepSpinner;
}

export async function createContext(input: CreateContextInput): Promise<Context> {
  return {
    cwd: process.cwd(),
    os: "ubuntu",
    dryRun: input.dryRun,
    yes: input.yes,
    log: console,
    ui: input.ui,
    run: async () => {
      throw new Error("Subprocess runner arrives in Phase 2.");
    },
    manifest: await StateManifest.load(process.cwd()),
  };
}
