import { printable } from "../core/untrusted-text.js";
import type { ProposedOperation } from "../plugins/types.js";
import { box } from "./box.js";
import { indent } from "./format.js";
import { capabilityLabel } from "./labels.js";
import { symbol } from "./symbols.js";
import { theme } from "./theme.js";

export interface SummarySkip {
  label: string;
  reason: string;
}

export type RunSummary =
  | { kind: "success"; applied: ProposedOperation[]; nextSteps: string[] }
  | { kind: "declined"; skipped: SummarySkip[] }
  | { kind: "partial"; appliedCount: number; problems: string[] }
  | {
      kind: "failure";
      message: string;
      restored: string[];
      reverted: string[];
      kept: string[];
      manualCleanup: string[];
    };

function printableLines(lines: string[]): string {
  return lines.map(printable).join("\n");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capabilityLines(applied: ProposedOperation[]): string[] {
  const byCapability = new Map<string, number>();
  for (const operation of applied) {
    byCapability.set(
      operation.capabilityId,
      (byCapability.get(operation.capabilityId) ?? 0) + 1,
    );
  }
  const rows = [...byCapability].map(([capabilityId, count]) => ({
    label: capabilityLabel(capabilityId),
    count,
  }));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  return rows.map(
    (row) =>
      `  ${row.label.padEnd(labelWidth)} ${pluralize(row.count, "operation")}`,
  );
}

export function renderRunSummary(summary: RunSummary): string {
  if (summary.kind === "success") {
    const title = `${symbol("ok")} Applied ${pluralize(
      summary.applied.length,
      "operation",
    )} · environment verified`;
    const lines = capabilityLines(summary.applied);
    if (summary.nextSteps.length > 0) {
      lines.push("", theme.heading("Next steps"));
      for (const step of summary.nextSteps) {
        lines.push(`  ${symbol("arrow")} ${printable(step)}`);
      }
    }
    return box({ title, body: lines.join("\n"), tone: "ok" });
  }

  if (summary.kind === "declined") {
    const title = `${symbol("warn")} Nothing applied — every operation was declined or skipped`;
    const body =
      summary.skipped.length === 0
        ? "No operations were proposed."
        : summary.skipped
            .map(
              (skip) =>
                `  ${printable(skip.label)} — ${theme.dim(printable(skip.reason))}`,
            )
            .join("\n");
    return box({ title, body, tone: "warn" });
  }

  if (summary.kind === "partial") {
    const title = `${symbol("warn")} Applied ${pluralize(
      summary.appliedCount,
      "operation",
    )}, then verification found problems`;
    const body = summary.problems
      .map((problem) => `  ${symbol("warn")} ${printable(problem)}`)
      .join("\n");
    return box({ title, body, tone: "warn" });
  }

  const title =
    summary.kept.length === 0
      ? `${symbol("fail")} Rolled back — repo and machine left as they started`
      : `${symbol("fail")} Rolled back — except the changes listed under Kept`;
  const blocks: string[] = [theme.dim(printable(summary.message))];
  if (summary.kept.length > 0) {
    blocks.push(
      `${theme.heading("Kept")}\n${indent(printableLines(summary.kept))}`,
    );
  }
  if (summary.restored.length > 0) {
    blocks.push(
      `${theme.heading("Restored")}\n${indent(printableLines(summary.restored))}`,
    );
  }
  if (summary.reverted.length > 0) {
    blocks.push(
      `${theme.heading("Reverted")}\n${indent(printableLines(summary.reverted))}`,
    );
  }
  if (summary.manualCleanup.length > 0) {
    blocks.push(
      `${theme.danger("Manual cleanup needed")}\n${indent(printableLines(summary.manualCleanup))}`,
    );
  }
  return box({ title, body: blocks.join("\n\n"), tone: "danger" });
}
