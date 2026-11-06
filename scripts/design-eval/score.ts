import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BuildCapture,
  buildAppropriateness,
  buildFingerprint,
  capturesDirectory,
  DESKTOP_WIDTH,
  screenshotFile,
} from "./capture.js";
import { type Arm, EVAL_ROOT } from "./claude.js";
import {
  applyPassRule,
  decodePng,
  meanPairwiseDistance,
  type ScreenshotSignature,
  screenshotSignature,
  topValueShare,
} from "./measures.js";

export interface ScoredCapture {
  capture: BuildCapture;
  signature: ScreenshotSignature | null;
}

function meanOf(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summariseGroup(entries: ScoredCapture[]) {
  const rendered = entries.filter(
    ({ capture }) => capture.status === "rendered",
  );
  const fingerprints = rendered.flatMap(({ capture }) => {
    const fingerprint = buildFingerprint(capture);
    return fingerprint ? [fingerprint] : [];
  });
  const appropriateness = entries.map(({ capture }) =>
    buildAppropriateness(capture),
  );
  const signatures = rendered.flatMap(({ signature }) =>
    signature ? [signature] : [],
  );
  return {
    builds: entries.length,
    notRendered: entries.length - rendered.length,
    meanDistance: meanPairwiseDistance(signatures),
    meanTellCount: meanOf(fingerprints.map(({ tellCount }) => tellCount)),
    meanAppropriateness: meanOf(appropriateness.map(({ points }) => points)),
    appropriatenessOf: appropriateness[0]?.of ?? 0,
    fingerprints,
  };
}

// Distance is only meaningful within one brief, so arm figures average the briefs' own figures.
function meanAcrossBriefs(
  groups: ReturnType<typeof summariseGroup>[],
  pick: (group: ReturnType<typeof summariseGroup>) => number | null,
): number | null {
  return meanOf(
    groups.flatMap((group) => {
      const value = pick(group);
      return value === null ? [] : [value];
    }),
  );
}

export function summariseCaptures(entries: ScoredCapture[]) {
  const armsSeen = [...new Set(entries.map(({ capture }) => capture.arm))];
  const briefsSeen = [...new Set(entries.map(({ capture }) => capture.brief))];
  const briefs: Record<
    string,
    Partial<Record<Arm, ReturnType<typeof summariseGroup>>>
  > = {};
  for (const brief of briefsSeen) {
    briefs[brief] = {};
    for (const arm of armsSeen) {
      const group = entries.filter(
        ({ capture }) => capture.brief === brief && capture.arm === arm,
      );
      if (group.length > 0) briefs[brief][arm] = summariseGroup(group);
    }
  }
  const arms: Partial<
    Record<
      Arm,
      {
        builds: number;
        notRendered: number;
        meanDistance: number | null;
        meanTellCount: number | null;
        meanAppropriateness: number | null;
        topFont: ReturnType<typeof topValueShare>;
        topPaletteFamily: ReturnType<typeof topValueShare>;
      }
    >
  > = {};
  for (const arm of armsSeen) {
    const groups = Object.values(briefs).flatMap((brief) => {
      const group = brief[arm];
      return group ? [group] : [];
    });
    const fingerprints = groups.flatMap(({ fingerprints }) => fingerprints);
    arms[arm] = {
      builds: groups.reduce((sum, { builds }) => sum + builds, 0),
      notRendered: groups.reduce(
        (sum, { notRendered }) => sum + notRendered,
        0,
      ),
      meanDistance: meanAcrossBriefs(groups, (group) => group.meanDistance),
      meanTellCount: meanAcrossBriefs(groups, (group) => group.meanTellCount),
      meanAppropriateness: meanAcrossBriefs(
        groups,
        (group) => group.meanAppropriateness,
      ),
      topFont: topValueShare(
        fingerprints.flatMap(({ fonts }) => fonts.slice(0, 1)),
      ),
      topPaletteFamily: topValueShare(
        fingerprints.map(({ paletteFamily }) => paletteFamily),
      ),
    };
  }
  return { briefs, arms };
}

function listDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name);
}

export function loadCaptures(label: string): ScoredCapture[] {
  const root = capturesDirectory(label);
  return listDirectories(root).flatMap((brief) =>
    listDirectories(join(root, brief)).map((build) => {
      const directory = join(root, brief, build);
      const capture = JSON.parse(
        readFileSync(join(directory, "capture.json"), "utf8"),
      ) as BuildCapture;
      const shot = join(directory, screenshotFile(DESKTOP_WIDTH));
      return {
        capture,
        signature: existsSync(shot)
          ? screenshotSignature(decodePng(readFileSync(shot)))
          : null,
      };
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      preference: { type: "string" },
    },
  });
  if (!values.label) throw new Error("--label is required");
  const summary = summariseCaptures(loadCaptures(values.label));
  const preference = values.preference
    ? JSON.parse(readFileSync(values.preference, "utf8")).preference
    : null;
  const { A, C } = summary.arms;
  const passRule = applyPassRule({
    distance: { A: A?.meanDistance ?? null, C: C?.meanDistance ?? null },
    tells: { A: A?.meanTellCount ?? null, C: C?.meanTellCount ?? null },
    appropriateness: {
      A: A?.meanAppropriateness ?? null,
      C: C?.meanAppropriateness ?? null,
    },
    preference,
  });
  const report = {
    label: values.label,
    strength: "indicative",
    scorer: "dependency-free pixel distance, lightly validated",
    passRule,
    preference,
    ...summary,
  };
  const output = join(EVAL_ROOT, "results", `${values.label}-score.json`);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passRule, arms: summary.arms }, null, 2));
  console.log(`results: ${output}`);
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
