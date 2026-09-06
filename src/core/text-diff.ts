import { theme } from "../ui/theme.js";

type DiffLineKind = " " | "+" | "-";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const DEFAULT_CONTEXT = 3;

export interface RenderDiffOptions {
  color?: boolean;
  context?: number;
  maxLines?: number;
}

function splitIntoLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function diffLineSequences(before: string[], after: string[]): DiffLine[] {
  const beforeCount = before.length;
  const afterCount = after.length;
  const commonSuffixLengths: number[][] = Array.from(
    { length: beforeCount + 1 },
    () => new Array<number>(afterCount + 1).fill(0),
  );

  for (let beforeIndex = beforeCount - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterCount - 1; afterIndex >= 0; afterIndex -= 1) {
      commonSuffixLengths[beforeIndex][afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? commonSuffixLengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(
              commonSuffixLengths[beforeIndex + 1][afterIndex],
              commonSuffixLengths[beforeIndex][afterIndex + 1],
            );
    }
  }

  const diff: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeCount && afterIndex < afterCount) {
    if (before[beforeIndex] === after[afterIndex]) {
      diff.push({ kind: " ", text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      commonSuffixLengths[beforeIndex + 1][afterIndex] >=
      commonSuffixLengths[beforeIndex][afterIndex + 1]
    ) {
      diff.push({ kind: "-", text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      diff.push({ kind: "+", text: after[afterIndex] });
      afterIndex += 1;
    }
  }
  while (beforeIndex < beforeCount) {
    diff.push({ kind: "-", text: before[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < afterCount) {
    diff.push({ kind: "+", text: after[afterIndex] });
    afterIndex += 1;
  }
  return diff;
}

function collapseUnchangedRuns(body: string[], context: number): string[] {
  const result: string[] = [];
  let unchangedRun: string[] = [];

  const flush = (): void => {
    if (unchangedRun.length > context * 2) {
      const hiddenCount = unchangedRun.length - context * 2;
      result.push(...unchangedRun.slice(0, context));
      result.push(`  ⋯ ${hiddenCount} unchanged lines`);
      result.push(...unchangedRun.slice(unchangedRun.length - context));
    } else {
      result.push(...unchangedRun);
    }
    unchangedRun = [];
  };

  for (const line of body) {
    if (line.startsWith(" ") || line === "") {
      unchangedRun.push(line);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();
  return result;
}

/**
 * Re-style an already-rendered unified diff string: colour the `+`/`-` lines,
 * dim the `---`/`+++` header, and collapse long unchanged runs. Operates on the
 * rendered form so callers holding only `operation.preview.text` can dress it.
 */
export function styleUnifiedDiff(
  diffText: string,
  options: RenderDiffOptions = {},
): string {
  const useColor = options.color ?? false;
  const context = options.context ?? DEFAULT_CONTEXT;

  const lines = diffText.split("\n");
  const header: string[] = [];
  let bodyStart = 0;
  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      header.push(line);
      bodyStart += 1;
      continue;
    }
    break;
  }

  const collapsed = collapseUnchangedRuns(lines.slice(bodyStart), context);
  const limited =
    options.maxLines !== undefined && collapsed.length > options.maxLines
      ? [
          ...collapsed.slice(0, options.maxLines),
          `  ⋯ diff trimmed, ${collapsed.length - options.maxLines} more lines`,
        ]
      : collapsed;

  const paintBodyLine = (line: string): string => {
    if (!useColor) return line;
    if (line.startsWith("+")) return theme.added(line);
    if (line.startsWith("-")) return theme.removed(line);
    if (line.startsWith("  ⋯")) return theme.dim(line);
    return line;
  };

  return [
    ...header.map((line) => (useColor ? theme.dim(line) : line)),
    ...limited.map(paintBodyLine),
  ].join("\n");
}

export function renderUnifiedDiff(
  before: string,
  after: string,
  label: string,
  options: RenderDiffOptions = {},
): string {
  const diff = diffLineSequences(splitIntoLines(before), splitIntoLines(after));
  const body = diff.map((line) => `${line.kind}${line.text}`).join("\n");
  const raw = `--- ${label}\n+++ ${label}\n${body}`;

  if (
    options.color === undefined &&
    options.context === undefined &&
    options.maxLines === undefined
  ) {
    return raw;
  }
  return styleUnifiedDiff(raw, options);
}
