const MIN_SIGNIFICANT_LINE_LENGTH = 12;
const OVERLAP_SIMILARITY_THRESHOLD = 0.5;
const POINTER_MAX_NORMALIZED_LENGTH = 800;
const CANONICAL_RULE_FILE = "AGENTS.md";

export type RuleFileRole = "canonical" | "pointer" | "unknown";
export type DuplicationReportScope = "all" | "involving-canonical";

export interface OverlapFinding {
  left: string;
  right: string;
  leftRole: RuleFileRole;
  rightRole: RuleFileRole;
  similarity: number;
  bothRuleBearing: boolean;
}

export interface DuplicationReport {
  overlaps: OverlapFinding[];
}

export interface RuleFileContents {
  path: string;
  contents: string | null;
}

export interface DetectDuplicationOptions {
  report?: DuplicationReportScope;
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

function classifyRole(path: string, contents: string): RuleFileRole {
  if (path === CANONICAL_RULE_FILE) {
    return "canonical";
  }
  const normalizedLength = contents.replace(/\s+/g, " ").trim().length;
  const referencesCanonical = /AGENTS\.md/i.test(contents);
  if (
    normalizedLength <= POINTER_MAX_NORMALIZED_LENGTH &&
    referencesCanonical
  ) {
    return "pointer";
  }
  return "unknown";
}

function overlapIsReportable(
  leftRole: RuleFileRole,
  rightRole: RuleFileRole,
  scope: DuplicationReportScope,
): boolean {
  if (leftRole === "pointer" && rightRole === "pointer") {
    return false;
  }
  if (scope === "involving-canonical") {
    return leftRole === "canonical" || rightRole === "canonical";
  }
  return true;
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
  options: DetectDuplicationOptions = {},
): DuplicationReport {
  const scope = options.report ?? "involving-canonical";

  const normalizedFiles = ruleFiles
    .filter(
      (file): file is { path: string; contents: string } =>
        file.contents !== null,
    )
    .map((file) => ({
      path: file.path,
      role: classifyRole(file.path, file.contents),
      lines: normalizeToSignificantLines(file.contents),
    }));

  const overlaps: OverlapFinding[] = [];
  for (let leftIndex = 0; leftIndex < normalizedFiles.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalizedFiles.length;
      rightIndex += 1
    ) {
      const left = normalizedFiles[leftIndex];
      const right = normalizedFiles[rightIndex];
      if (!overlapIsReportable(left.role, right.role, scope)) {
        continue;
      }

      const similarity = jaccardSimilarity(left.lines, right.lines);
      if (similarity >= OVERLAP_SIMILARITY_THRESHOLD) {
        overlaps.push({
          left: left.path,
          right: right.path,
          leftRole: left.role,
          rightRole: right.role,
          similarity: Math.round(similarity * 100) / 100,
          bothRuleBearing: left.role !== "pointer" && right.role !== "pointer",
        });
      }
    }
  }

  return { overlaps };
}

export function describeOverlap(overlap: OverlapFinding): string {
  const reason = overlap.bothRuleBearing
    ? "both carry rule content"
    : `similarity ${overlap.similarity}`;
  return `${overlap.left} ~ ${overlap.right} (${reason})`;
}
