import { theme } from "../ui/theme.js";

type DiffLineKind = " " | "+" | "-";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const DEFAULT_CONTEXT = 3;
const MAX_LCS_TABLE_CELLS = 1_000_000;
const ELLIPSIS_LINE_PREFIX = "  ⋯";

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

function countCommonPrefix(before: string[], after: string[]): number {
  const limit = Math.min(before.length, after.length);
  let count = 0;
  while (count < limit && before[count] === after[count]) {
    count += 1;
  }
  return count;
}

function countCommonSuffix(
  before: string[],
  after: string[],
  prefixLength: number,
): number {
  const limit = Math.min(before.length, after.length) - prefixLength;
  let count = 0;
  while (
    count < limit &&
    before[before.length - 1 - count] === after[after.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function contextLines(lines: string[]): DiffLine[] {
  return lines.map((text) => ({ kind: " ", text }));
}

function diffWithLongestCommonSubsequence(
  before: string[],
  after: string[],
): DiffLine[] {
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

function diffChangedMiddle(before: string[], after: string[]): DiffLine[] {
  const tableCells = (before.length + 1) * (after.length + 1);
  if (tableCells > MAX_LCS_TABLE_CELLS) {
    return [
      {
        kind: " ",
        text: ` ⋯ too large to diff line by line: ${before.length} lines replaced by ${after.length} lines`,
      },
    ];
  }
  return diffWithLongestCommonSubsequence(before, after);
}

function diffLineSequences(before: string[], after: string[]): DiffLine[] {
  const prefixLength = countCommonPrefix(before, after);
  const suffixLength = countCommonSuffix(before, after, prefixLength);
  return [
    ...contextLines(before.slice(0, prefixLength)),
    ...diffChangedMiddle(
      before.slice(prefixLength, before.length - suffixLength),
      after.slice(prefixLength, after.length - suffixLength),
    ),
    ...contextLines(before.slice(before.length - suffixLength)),
  ];
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
    const isUnchangedLine =
      (line.startsWith(" ") && !line.startsWith(ELLIPSIS_LINE_PREFIX)) ||
      line === "";
    if (isUnchangedLine) {
      unchangedRun.push(line);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();
  return result;
}
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
    if (line.startsWith(ELLIPSIS_LINE_PREFIX)) return theme.dim(line);
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
