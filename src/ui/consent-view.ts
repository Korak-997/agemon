import type { ProposedOperation } from "../plugins/types.js";
import { indent } from "./format.js";
import { symbol } from "./symbols.js";
import { theme } from "./theme.js";

const GATE_TITLES: Record<string, string> = {
  "workspace-isolation": "Workspace isolation",
  "install-tooling": "Install tooling",
  "register-service": "Register background service",
  "write-config": "Write structured config",
  "touch-instruction-files": "Write instruction files",
  "resolve-conflict": "Resolve conflicts",
};

export function gateLegend(): string {
  return `${theme.accent("[y]")} proceed   ${theme.accent("[n]")} skip   ${theme.accent(
    "[d]",
  )} show diffs`;
}

export function conflictLegend(): string {
  return `${theme.accent("[k]")} keep yours   ${theme.accent(
    "[s]",
  )} show agemon's   ${theme.accent("[x]")} skip`;
}

function gateTitle(gateId: string): string {
  return GATE_TITLES[gateId] ?? gateId;
}

function operationLine(operation: ProposedOperation): string {
  const target = operation.targetPath || operation.resourceId;
  return `${symbol("arrow")} ${target}`;
}

export function renderGateIntro(input: {
  index: number;
  total: number;
  gateId: string;
  operations: ProposedOperation[];
}): string {
  const heading = theme.heading(
    `Gate ${input.index} / ${input.total}  ${theme.dim("·")}  ${gateTitle(
      input.gateId,
    )}`,
  );
  if (input.operations.length === 0) {
    return heading;
  }
  return `${heading}\n${indent(
    input.operations.map(operationLine).join("\n"),
  )}`;
}
