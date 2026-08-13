import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MANIFEST_RELATIVE_PATH = ".agemon/state.json";

export interface ManifestAction {
  id: string;
  plugin: string;
  type: string;
  target: string;
  preExisting: boolean;
  createdAt: string;
}

export interface StateManifestData {
  version: 1;
  createdAt: string;
  updatedAt: string;
  os: "linux";
  actions: ManifestAction[];
}

export interface RecordManifestActionInput {
  plugin: string;
  type: string;
  target: string;
  preExisting: boolean;
}

function createDefaultState(now: string): StateManifestData {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    os: "linux",
    actions: [],
  };
}

function isManifestAction(value: unknown): value is ManifestAction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Partial<ManifestAction>;
  return (
    typeof typed.id === "string" &&
    typeof typed.plugin === "string" &&
    typeof typed.type === "string" &&
    typeof typed.target === "string" &&
    typeof typed.preExisting === "boolean" &&
    typeof typed.createdAt === "string"
  );
}

function isStateManifestData(value: unknown): value is StateManifestData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Partial<StateManifestData>;
  return (
    typed.version === 1 &&
    typed.os === "linux" &&
    typeof typed.createdAt === "string" &&
    typeof typed.updatedAt === "string" &&
    Array.isArray(typed.actions) &&
    typed.actions.every((action) => isManifestAction(action))
  );
}

export class StateManifest {
  private constructor(
    private readonly manifestPath: string,
    private state: StateManifestData,
  ) {}

  static async load(cwd: string): Promise<StateManifest> {
    const manifestPath = join(cwd, MANIFEST_RELATIVE_PATH);
    const now = new Date().toISOString();

    try {
      const contents = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(contents) as unknown;
      if (!isStateManifestData(parsed)) {
        throw new Error("State manifest has an invalid schema");
      }
      return new StateManifest(manifestPath, parsed);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return new StateManifest(manifestPath, createDefaultState(now));
      }
      throw new Error(
        `Unable to load manifest at ${manifestPath}: ${String(error)}`,
      );
    }
  }

  getActions(): ManifestAction[] {
    return [...this.state.actions];
  }

  hasActions(): boolean {
    return this.state.actions.length > 0;
  }

  hasActionForPlugin(plugin: string): boolean {
    return this.state.actions.some((action) => action.plugin === plugin);
  }

  async recordAction(
    input: RecordManifestActionInput,
  ): Promise<ManifestAction> {
    const action: ManifestAction = {
      id: randomUUID(),
      plugin: input.plugin,
      type: input.type,
      target: input.target,
      preExisting: input.preExisting,
      createdAt: new Date().toISOString(),
    };
    this.state.actions.push(action);
    await this.persist();
    return action;
  }

  async removeActionsForPlugin(plugin: string): Promise<void> {
    const nextActions = this.state.actions.filter(
      (action) => action.plugin !== plugin,
    );
    if (nextActions.length === this.state.actions.length) {
      return;
    }
    this.state.actions = nextActions;
    await this.persist();
  }

  async pruneIfEmpty(): Promise<void> {
    if (this.state.actions.length > 0) {
      return;
    }

    const manifestDir = dirname(this.manifestPath);
    await rm(this.manifestPath, { force: true });
    try {
      await rm(manifestDir, { recursive: false });
    } catch {
      return;
    }
  }

  private async persist(): Promise<void> {
    const now = new Date().toISOString();
    this.state.updatedAt = now;

    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const manifestDir = dirname(this.manifestPath);
    const tempPath = `${this.manifestPath}.tmp-${process.pid}-${Date.now()}`;

    await mkdir(manifestDir, { recursive: true });
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.manifestPath);
  }
}
