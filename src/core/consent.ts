import type { IsolationStatus } from "../inspect/discover.js";
import type {
  ProposedOperation,
  ProposedOperationAction,
} from "../plugins/types.js";
import type { Plan } from "./plan-store.js";
import {
  type ConflictReply,
  type GateReply,
  isInteractiveTerminal,
  promptConflict,
  promptGate,
} from "./prompt.js";

export type ConsentGateId =
  | "workspace-isolation"
  | "install-tooling"
  | "register-service"
  | "write-config"
  | "touch-instruction-files"
  | "resolve-conflict";

export interface ConsentGate {
  id: ConsentGateId;
  summary: string;
  operations: ProposedOperation[];
  forcesDiff: boolean;
  satisfiableWithYes: boolean;
}

export interface SkippedOperation {
  operation: ProposedOperation;
  reason: string;
}

export type RecordedConflictDecision = "keep-mine" | "skip";

export interface ConflictResolution {
  resourceId: string;
  decision: RecordedConflictDecision;
}

export interface ApprovedOperationSet {
  approved: ProposedOperation[];
  skipped: SkippedOperation[];
  workspaceIsolationApproved: boolean | null;
  conflictResolutions: ConflictResolution[];
}

const INSTRUCTION_FILE_ACTIONS: ReadonlySet<ProposedOperationAction> = new Set([
  "create",
  "replace",
  "merge-block",
  "adopt",
]);

type OperationGateId = Exclude<ConsentGateId, "workspace-isolation">;

const OPERATION_GATE_ORDER: readonly OperationGateId[] = [
  "install-tooling",
  "register-service",
  "write-config",
  "touch-instruction-files",
  "resolve-conflict",
];

export interface BuildConsentGatesInput {
  plan: Plan;
  isolationStatus: IsolationStatus;
}

export function buildConsentGates(
  input: BuildConsentGatesInput,
): ConsentGate[] {
  const gates: ConsentGate[] = [];

  if (input.isolationStatus !== "ignored") {
    gates.push({
      id: "workspace-isolation",
      summary: isolationGateSummary(input.isolationStatus),
      operations: [],
      forcesDiff: false,
      satisfiableWithYes: true,
    });
  }

  const operationsByGate = new Map<OperationGateId, ProposedOperation[]>();
  for (const operation of input.plan.operations) {
    const gateId = gateForOperation(operation);
    if (gateId === null) {
      continue;
    }
    const bucket = operationsByGate.get(gateId);
    if (bucket) {
      bucket.push(operation);
    } else {
      operationsByGate.set(gateId, [operation]);
    }
  }

  for (const gateId of OPERATION_GATE_ORDER) {
    const operations = operationsByGate.get(gateId);
    if (operations === undefined) {
      continue;
    }
    gates.push({
      id: gateId,
      summary: operationGateSummary(gateId, operations),
      operations,
      forcesDiff: operations.some(
        (operation) => operation.riskClass === "credential-adjacent",
      ),
      satisfiableWithYes: gateId !== "resolve-conflict",
    });
  }

  return gates;
}

function gateForOperation(
  operation: ProposedOperation,
): OperationGateId | null {
  if (operation.action === "conflict") {
    return "resolve-conflict";
  }
  if (operation.action === "skip") {
    return null;
  }
  if (operation.riskClass === "inert" && !operation.requiresConsent) {
    return null;
  }
  if (operation.action === "install-package") {
    return "install-tooling";
  }
  if (operation.action === "register-service") {
    return "register-service";
  }
  if (operation.action === "merge-key") {
    return "write-config";
  }
  if (INSTRUCTION_FILE_ACTIONS.has(operation.action)) {
    return "touch-instruction-files";
  }
  return null;
}

function isolationGateSummary(status: IsolationStatus): string {
  if (status === "no-gitignore-file") {
    return "This repo has no .gitignore. agemon needs one so its regenerated state under .agemon/ is never committed. Create .gitignore with /.agemon/?";
  }
  return "agemon needs /.agemon/ git-ignored so its regenerated state is never committed. Add /.agemon/ to .gitignore?";
}

function operationGateSummary(
  gateId: OperationGateId,
  operations: ProposedOperation[],
): string {
  const targets = operations
    .map((operation) => operation.targetPath || operation.resourceId)
    .join(", ");
  switch (gateId) {
    case "install-tooling":
      return `Install ${operations.length} package(s) (${targets}). Uses pipx / npm. Proceed?`;
    case "register-service":
      return `Register ${operations.length} background service unit(s) (${targets}). Proceed?`;
    case "write-config":
      return `Merge ${operations.length} config key set(s) into ${targets}. Sibling keys stay untouched; exact diff shown. Proceed?`;
    case "touch-instruction-files":
      return `Write agemon's managed content into ${operations.length} instruction file(s) (${targets}). Your prose is preserved. Proceed?`;
    case "resolve-conflict":
      return `${operations.length} conflict(s) need an explicit decision.`;
  }
}

export interface GatePrompts {
  gate(summary: string): Promise<GateReply>;
  conflict(summary: string): Promise<ConflictReply>;
}

const readlinePrompts: GatePrompts = {
  gate: promptGate,
  conflict: promptConflict,
};

export interface ResolveConsentInput {
  gates: ConsentGate[];
  yes: boolean;
  log: Pick<Console, "log">;
  interactive?: boolean;
  prompts?: GatePrompts;
  conflictDecisions?: Record<string, RecordedConflictDecision>;
}

export async function resolveConsent(
  input: ResolveConsentInput,
): Promise<ApprovedOperationSet> {
  const interactive = input.interactive ?? isInteractiveTerminal();
  const prompts = input.prompts ?? readlinePrompts;
  const approved: ProposedOperation[] = [];
  const skipped: SkippedOperation[] = [];
  const conflictResolutions: ConflictResolution[] = [];
  let workspaceIsolationApproved: boolean | null = null;

  for (const gate of input.gates) {
    if (gate.id === "workspace-isolation") {
      workspaceIsolationApproved = await askGate(gate, {
        yes: input.yes,
        interactive,
        prompts,
        log: input.log,
      });
      if (!workspaceIsolationApproved) {
        input.log.log(
          "Declined: /.agemon/ stays un-ignored — apply will refuse to write .agemon/ state unless --allow-unignored-state is passed.",
        );
      }
      continue;
    }

    if (gate.id === "resolve-conflict") {
      for (const operation of gate.operations) {
        const recordedDecision =
          input.conflictDecisions?.[operation.resourceId];
        const { decision, reason } = recordedDecision
          ? {
              decision: recordedDecision,
              reason: `conflict ${recordedDecision === "keep-mine" ? "resolved by keeping your version" : "skipped"} per agemon.toml`,
            }
          : await resolveConflict(operation, {
              interactive,
              prompts,
              log: input.log,
            });
        if (decision !== null) {
          conflictResolutions.push({
            resourceId: operation.resourceId,
            decision,
          });
        }
        skipped.push({ operation, reason });
      }
      continue;
    }

    const gateApproved = await askGate(gate, {
      yes: input.yes,
      interactive,
      prompts,
      log: input.log,
    });
    if (gateApproved) {
      approved.push(...gate.operations);
      continue;
    }

    const reason =
      !input.yes && !interactive
        ? `no consent for the '${gate.id}' gate (non-interactive, no --yes)`
        : `declined at the '${gate.id}' consent gate`;
    for (const operation of gate.operations) {
      skipped.push({ operation, reason });
    }
    input.log.log(`Skipped ${gate.operations.length} operation(s): ${reason}.`);
  }

  return {
    approved,
    skipped,
    workspaceIsolationApproved,
    conflictResolutions,
  };
}

interface GateDecisionContext {
  yes: boolean;
  interactive: boolean;
  prompts: GatePrompts;
  log: Pick<Console, "log">;
}

async function askGate(
  gate: ConsentGate,
  ctx: GateDecisionContext,
): Promise<boolean> {
  if (ctx.yes && gate.satisfiableWithYes) {
    if (gate.forcesDiff) {
      printOperationPreviews(gate.operations, ctx.log);
    }
    return true;
  }
  if (!ctx.interactive) {
    return false;
  }

  const reply = await ctx.prompts.gate(gate.summary);
  if (reply === "show-diff") {
    printOperationPreviews(gate.operations, ctx.log);
    return askGate(gate, ctx);
  }
  return reply === "approve";
}

interface ConflictOutcome {
  decision: RecordedConflictDecision | null;
  reason: string;
}

async function resolveConflict(
  operation: ProposedOperation,
  ctx: Omit<GateDecisionContext, "yes">,
): Promise<ConflictOutcome> {
  if (!ctx.interactive) {
    return {
      decision: null,
      reason:
        "conflict left unresolved — needs an explicit decision (non-interactive)",
    };
  }

  const reply = await ctx.prompts.conflict(
    `Conflict at ${operation.targetPath || operation.resourceId}: keep yours, show agemon's, or skip?`,
  );
  if (reply === "show-theirs") {
    printOperationPreviews([operation], ctx.log);
    return resolveConflict(operation, ctx);
  }
  return reply === "keep-mine"
    ? {
        decision: "keep-mine",
        reason: "conflict resolved by keeping your version",
      }
    : { decision: "skip", reason: "conflict skipped by choice" };
}

function printOperationPreviews(
  operations: ProposedOperation[],
  log: Pick<Console, "log">,
): void {
  for (const operation of operations) {
    log.log(`--- ${operation.targetPath || operation.resourceId}`);
    log.log(operation.preview.text);
  }
}
