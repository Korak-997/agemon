type DiffLineKind = " " | "+" | "-";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
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

export function renderUnifiedDiff(
  before: string,
  after: string,
  label: string,
): string {
  const diff = diffLineSequences(splitIntoLines(before), splitIntoLines(after));
  const body = diff.map((line) => `${line.kind}${line.text}`).join("\n");
  return `--- ${label}\n+++ ${label}\n${body}`;
}
