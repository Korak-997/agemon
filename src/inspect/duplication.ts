const MIN_SIGNIFICANT_LINE_LENGTH = 12;
const OVERLAP_SIMILARITY_THRESHOLD = 0.5;

export interface OverlapFinding {
  left: string;
  right: string;
  similarity: number;
}

export interface DuplicationReport {
  overlaps: OverlapFinding[];
}

export interface RuleFileContents {
  path: string;
  contents: string | null;
}

function normalizeToSignificantLines(contents: string): Set<string> {
  const withoutHtmlComments = contents.replace(/<!--[\s\S]*?-->/g, " ");
  const significantLines = withoutHtmlComments
    .split(/\r?\n/)
    .map((line) =>
      line
        .toLowerCase()
        .replace(/[`*_>#]+/g, " ")
        .replace(/^\s*[-+]\s+/, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length >= MIN_SIGNIFICANT_LINE_LENGTH);
  return new Set(significantLines);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersectionSize += 1;
    }
  }

  const unionSize = left.size + right.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export function detectDuplication(
  ruleFiles: RuleFileContents[],
): DuplicationReport {
  const normalizedFiles = ruleFiles
    .filter(
      (file): file is { path: string; contents: string } =>
        file.contents !== null,
    )
    .map((file) => ({
      path: file.path,
      lines: normalizeToSignificantLines(file.contents),
    }));

  const overlaps: OverlapFinding[] = [];
  for (let leftIndex = 0; leftIndex < normalizedFiles.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalizedFiles.length;
      rightIndex += 1
    ) {
      const similarity = jaccardSimilarity(
        normalizedFiles[leftIndex].lines,
        normalizedFiles[rightIndex].lines,
      );
      if (similarity >= OVERLAP_SIMILARITY_THRESHOLD) {
        overlaps.push({
          left: normalizedFiles[leftIndex].path,
          right: normalizedFiles[rightIndex].path,
          similarity: Math.round(similarity * 100) / 100,
        });
      }
    }
  }

  return { overlaps };
}
