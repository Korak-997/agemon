import {
  type ProposedOperation,
  UNREADABLE_GIT_CONFIG_CATEGORIES,
  type UnreadableGitConfigCategory,
  type UntrustedGitConfig,
} from "../plugins/types.js";
import type { SkippedOperation } from "./consent.js";
import type { Context } from "./context.js";
import { isSafeIdentifier } from "./untrusted-text.js";

export const MAX_UNTRUSTED_GIT_CONFIG_PAIRS = 20;
export const MAX_GIT_CONFIG_SOURCE_CHARACTERS = 60;
export const MAX_GIT_CONFIG_KEY_CHARACTERS = 200;
export const MAX_GIT_CONFIG_VALUE_CHARACTERS = 200;
export const MAX_UNTRUSTED_GIT_CONFIG_PAIR_CHARACTERS =
  MAX_GIT_CONFIG_SOURCE_CHARACTERS +
  ": ".length +
  MAX_GIT_CONFIG_KEY_CHARACTERS +
  "=".length +
  MAX_GIT_CONFIG_VALUE_CHARACTERS;

export type GitConfigGuardResult =
  | { kind: "clean" }
  | Exclude<UntrustedGitConfig, { kind: "unreadable" }>
  | {
      kind: "unreadable";
      category: UnreadableGitConfigCategory;
      detail: string;
    };

export interface GitConfigGuard {
  planned(): Promise<GitConfigGuardResult>;
  recheck(): Promise<GitConfigGuardResult>;
}

export const CLEAN_GIT_CONFIG: GitConfigGuardResult = { kind: "clean" };

export const UNTRUSTED_GIT_CONFIG_REMEDY =
  "Remove them, or run 'agemon nuke --only crg' and then 'agemon --only crg' interactively to review them in the trust gate.";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function validateUntrustedGitConfig(
  value: unknown,
  field: string,
  fail: (detail: string) => never,
): UntrustedGitConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`'${field}' must be an object`);
  }
  const record = value as Record<string, unknown>;
  const fingerprint = (): string =>
    typeof record.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(record.fingerprint)
      ? record.fingerprint
      : fail(`'${field}.fingerprint' must be 64 lowercase hex characters`);
  switch (record.kind) {
    case "pairs": {
      const pairs = record.pairs;
      if (
        !Array.isArray(pairs) ||
        pairs.length === 0 ||
        pairs.length > MAX_UNTRUSTED_GIT_CONFIG_PAIRS ||
        !pairs.every(
          (pair) =>
            typeof pair === "string" &&
            pair.length <= MAX_UNTRUSTED_GIT_CONFIG_PAIR_CHARACTERS &&
            isSafeIdentifier(pair),
        )
      ) {
        return fail(
          `'${field}.pairs' must hold 1 to ${MAX_UNTRUSTED_GIT_CONFIG_PAIRS} safe strings of at most ${MAX_UNTRUSTED_GIT_CONFIG_PAIR_CHARACTERS} characters`,
        );
      }
      return {
        kind: "pairs",
        pairs: pairs as string[],
        fingerprint: fingerprint(),
      };
    }
    case "tooMany":
      return Number.isSafeInteger(record.count) &&
        (record.count as number) > MAX_UNTRUSTED_GIT_CONFIG_PAIRS
        ? {
            kind: "tooMany",
            count: record.count as number,
            fingerprint: fingerprint(),
          }
        : fail(
            `'${field}.count' must be an integer above ${MAX_UNTRUSTED_GIT_CONFIG_PAIRS}`,
          );
    case "unshowable":
      return { kind: "unshowable", fingerprint: fingerprint() };
    case "unreadable":
      return UNREADABLE_GIT_CONFIG_CATEGORIES.includes(
        record.category as UnreadableGitConfigCategory,
      )
        ? {
            kind: "unreadable",
            category: record.category as UnreadableGitConfigCategory,
          }
        : fail(
            `'${field}.category' must be one of ${UNREADABLE_GIT_CONFIG_CATEGORIES.join(", ")}`,
          );
    default:
      return fail(
        `'${field}.kind' must be one of pairs, tooMany, unshowable, unreadable`,
      );
  }
}

function untrustedGitConfigField(
  result: GitConfigGuardResult,
): UntrustedGitConfig | undefined {
  if (result.kind === "clean") {
    return undefined;
  }
  return result.kind === "unreadable"
    ? { kind: "unreadable", category: result.category }
    : result;
}

export function describeUntrustedGitConfig(field: UntrustedGitConfig): string {
  switch (field.kind) {
    case "pairs":
      return `untrusted repository git config: ${field.pairs.join("; ")}`;
    case "tooMany":
      return `too many untrusted git config keys to review (${field.count} > ${MAX_UNTRUSTED_GIT_CONFIG_PAIRS})`;
    case "unshowable":
      return "untrusted git config contains entries that cannot be shown safely";
    case "unreadable":
      return `could not read this repository's git config (${field.category})`;
  }
}

function gitConfigMatchesPlan(
  current: GitConfigGuardResult,
  planned: UntrustedGitConfig | undefined,
): boolean {
  if (planned === undefined || current.kind === "clean") {
    return planned === undefined && current.kind === "clean";
  }
  if (current.kind === "unreadable" || planned.kind === "unreadable") {
    return false;
  }
  return (
    current.kind === planned.kind && current.fingerprint === planned.fingerprint
  );
}

export async function assertGitConfigMatchesPlan(
  guard: GitConfigGuard,
  operation: ProposedOperation | undefined,
): Promise<void> {
  if (
    !gitConfigMatchesPlan(await guard.recheck(), operation?.untrustedGitConfig)
  ) {
    throw new Error(
      "this repository's git config changed since the plan; run 'agemon plan' again and review it",
    );
  }
}

export async function markUntrustedGitConfig(
  ctx: Pick<Context, "gitConfigGuard" | "ui">,
  operations: ProposedOperation[],
  options: {
    runsGit: (operation: ProposedOperation) => boolean;
    reportsUnreadableConfig: boolean;
  },
): Promise<ProposedOperation[]> {
  const { runsGit } = options;
  if (!operations.some(runsGit)) {
    return operations;
  }
  const result = await ctx.gitConfigGuard.planned();
  if (result.kind === "unreadable" && options.reportsUnreadableConfig) {
    ctx.ui.info(
      `could not read this repository's git config: ${result.detail}`,
    );
  }
  const field = untrustedGitConfigField(result);
  return field === undefined
    ? operations
    : operations.map((operation) =>
        runsGit(operation)
          ? { ...operation, untrustedGitConfig: field }
          : operation,
      );
}

function summarizeUntrustedKeys(
  result: Exclude<GitConfigGuardResult, { kind: "clean" | "unreadable" }>,
): string {
  switch (result.kind) {
    case "pairs":
      return result.pairs.join("; ");
    case "tooMany":
      return `${result.count} keys`;
    case "unshowable":
      return "entries that cannot be shown safely";
  }
}

type GitConfigVerification =
  | { kind: "trusted" }
  | { kind: "unreadable"; detail: string }
  | { kind: "untrusted"; untrustedKeys: string };

export async function verifyRepositoryGitConfig(
  guard: GitConfigGuard,
): Promise<GitConfigVerification> {
  const result = await guard.planned();
  if (result.kind === "clean") {
    return { kind: "trusted" };
  }
  if (result.kind === "unreadable") {
    return {
      kind: "unreadable",
      detail: `could not read this repository's git config: ${result.detail}`,
    };
  }
  return { kind: "untrusted", untrustedKeys: summarizeUntrustedKeys(result) };
}

export function joinAttention(...attentions: Array<string | undefined>): {
  attention?: string;
} {
  const shown = attentions.filter(
    (attention): attention is string => attention !== undefined,
  );
  return shown.length === 0 ? {} : { attention: shown.join("; ") };
}

export function needsGitConfigApproval(operation: ProposedOperation): boolean {
  return operation.untrustedGitConfig?.kind === "pairs";
}

export function skipUnapprovableGitConfigOperations(
  operations: ProposedOperation[],
): { approvable: ProposedOperation[]; skipped: SkippedOperation[] } {
  const approvable: ProposedOperation[] = [];
  const skipped: SkippedOperation[] = [];
  for (const operation of operations) {
    if (
      operation.untrustedGitConfig === undefined ||
      needsGitConfigApproval(operation)
    ) {
      approvable.push(operation);
    } else {
      skipped.push({
        operation,
        reason: describeUntrustedGitConfig(operation.untrustedGitConfig),
        consentMissing: true,
      });
    }
  }
  return { approvable, skipped };
}
