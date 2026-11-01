import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../src/core/context.js";
import {
  type RecordManifestActionInput,
  StateManifest,
} from "../../src/core/state-manifest.js";

const MANIFEST_PATH = [".agemon", "state.json"];

async function readLedgerFile(cwd: string): Promise<{
  version: number;
  createdAt: string;
  updatedAt: string;
  os: string;
  actions: Record<string, unknown>[];
}> {
  try {
    return JSON.parse(await readFile(join(cwd, ...MANIFEST_PATH), "utf8"));
  } catch {
    const now = new Date().toISOString();
    return {
      version: 3,
      createdAt: now,
      updatedAt: now,
      os: "linux",
      actions: [],
    };
  }
}

export async function appendLedgerClaims(
  ctx: Context,
  claims: RecordManifestActionInput[],
): Promise<void> {
  const ledger = await readLedgerFile(ctx.cwd);
  for (const claim of claims) {
    ledger.actions.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      planId: null,
      resourceId: null,
      ownershipMode: null,
      agemonVersion: null,
      fingerprintBefore: null,
      fingerprintAfter: null,
      desiredRevision: null,
      validation: null,
      backup: null,
      ...claim,
    });
  }
  await mkdir(join(ctx.cwd, ".agemon"), { recursive: true });
  await writeFile(
    join(ctx.cwd, ...MANIFEST_PATH),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  ctx.manifest = await StateManifest.load(ctx.cwd);
}
