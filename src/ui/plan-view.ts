import type { Plan } from "../core/plan-store.js";
import { styleUnifiedDiff } from "../core/text-diff.js";
import type {
  ProposedOperation,
  ProposedOperationAction,
  RiskClass,
} from "../plugins/types.js";
import { type CountPart, countLine, indent, rule } from "./format.js";
import { type SymbolName, symbol } from "./symbols.js";
import { theme } from "./theme.js";

const ACTION_GLYPH: Record<ProposedOperationAction, SymbolName> = {
  create: "add",
  "merge-block": "mod",
  "merge-key": "mod",
  replace: "mod",
  adopt: "adopt",
  "install-package": "install",
  "register-service": "install",
  conflict: "conflict",
  skip: "pending",
};

const ACTION_LABEL: Record<ProposedOperationAction, string> = {
  create: "create",
  "merge-block": "merge",
  "merge-key": "merge",
  replace: "replace",
  adopt: "adopt",
  "install-package": "install",
  "register-service": "register",
  conflict: "conflict",
  skip: "skip",
};

const RISK_LABEL: Record<RiskClass, string> = {
  inert: "inert",
  "writes-config": "writes-config",
  executes: "executes",
  "credential-adjacent": "credential-adjacent",
};

function groupByCapability(
  operations: ProposedOperation[],
): Map<string, ProposedOperation[]> {
  const grouped = new Map<string, ProposedOperation[]>();
  for (const operation of operations) {
    const bucket = grouped.get(operation.capabilityId);
    if (bucket) {
      bucket.push(operation);
    } else {
      grouped.set(operation.capabilityId, [operation]);
    }
  }
  return grouped;
}

function renderPreview(operation: ProposedOperation): string {
  if (operation.preview.kind === "diff") {
    return indent(
      styleUnifiedDiff(operation.preview.text, { color: true, context: 3 }),
      7,
    );
  }
  return indent(theme.dim(operation.preview.text), 7);
}

function renderOperation(operation: ProposedOperation): string {
  const glyph = symbol(ACTION_GLYPH[operation.action]);
  const badgeText = theme.dim(`[${RISK_LABEL[operation.riskClass]}]`);
  const target = operation.targetPath || operation.resourceId;
  const heading = `  ${glyph}  ${target.padEnd(24)} ${badgeText}`;
  return `${heading}\n${renderPreview(operation)}`;
}

function planFooter(operations: ProposedOperation[]): string {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const label = ACTION_LABEL[operation.action];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts: CountPart[] = [...counts].map(([label, n]) => ({ label, n }));
  return countLine(parts);
}

export function renderPlan(plan: Plan): string {
  const header = `${theme.heading(`Plan ${plan.id}`)}   ${theme.dim("·")}   ${theme.dim(
    `agemon ${plan.agemonVersion}`,
  )}`;

  if (plan.operations.length === 0) {
    return `${header}\n${rule()}\n\n  nothing to do — desired state already reached`;
  }

  const sections: string[] = [`${header}\n${rule()}`];
  for (const [capabilityId, operations] of groupByCapability(plan.operations)) {
    const body = operations.map(renderOperation).join("\n");
    sections.push(`${theme.heading(capabilityId)}\n${body}`);
  }
  sections.push(`${rule()}\n${planFooter(plan.operations)}`);

  return sections.join("\n\n");
}
