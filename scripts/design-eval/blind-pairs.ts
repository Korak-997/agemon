import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { capturesDirectory, DESKTOP_WIDTH, screenshotFile } from "./capture.js";
import { type Arm, EVAL_ROOT } from "./claude.js";
import {
  binomialTwoSidedP,
  decodePng,
  rocAuc,
  screenshotDistance,
  screenshotSignature,
} from "./measures.js";
import { loadCaptures } from "./score.js";

const DEFAULT_LOOK_PAIRS = 20;
const SAFE_RATER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/iu;
const OPAQUE_NAME_LENGTH = 16;

export type RaterKind = "human" | "llm";
export type PairMode = "preference" | "look";

export interface PairBuild {
  brief: string;
  arm: Arm;
  repeat: number;
  image: string;
}

export interface BlindPair {
  id: string;
  first: PairBuild;
  second: PairBuild;
}

export interface SheetItem {
  itemId: string;
  pairId: string;
  left: PairBuild;
  right: PairBuild;
}

export interface Rater {
  name: string;
  kind: RaterKind;
}

export interface PairKey {
  mode: PairMode;
  pairs?: BlindPair[];
  raters: Record<string, { kind: RaterKind; items: SheetItem[] }>;
}

export interface HumanVerdict {
  rater: string;
  choices: { itemId: string; picked: string }[];
}

function seededScore(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}\0${value}`).digest("hex");
}

function seededShuffle<Item>(
  items: Item[],
  seed: string,
  identify: (item: Item) => string,
): Item[] {
  return [...items].sort((left, right) =>
    seededScore(seed, identify(left)).localeCompare(
      seededScore(seed, identify(right)),
    ),
  );
}

function coinFlip(seed: string, value: string): boolean {
  return Number.parseInt(seededScore(seed, value).slice(0, 2), 16) % 2 === 0;
}

function buildsOf(builds: PairBuild[], brief: string, arm: Arm): PairBuild[] {
  return builds.filter((build) => build.brief === brief && build.arm === arm);
}

// Each build appears once, so one strong build cannot decide several votes.
export function planPreferencePairs(
  builds: PairBuild[],
  seed: string,
): BlindPair[] {
  const briefs = [...new Set(builds.map(({ brief }) => brief))].sort();
  return briefs.flatMap((brief) => {
    const shuffled = (arm: Arm) =>
      seededShuffle(buildsOf(builds, brief, arm), seed, ({ image }) => image);
    const controlBuilds = shuffled("A");
    return shuffled("C")
      .slice(0, controlBuilds.length)
      .map((second, index) => ({
        id: `${brief}-${index + 1}`,
        first: controlBuilds[index] as PairBuild,
        second,
      }));
  });
}

export function planLookPairs(
  builds: PairBuild[],
  seed: string,
  count: number,
): BlindPair[] {
  const candidates = builds.flatMap((first, index) =>
    builds
      .slice(index + 1)
      .filter((second) => second.brief === first.brief)
      .map((second) => ({ first, second })),
  );
  return seededShuffle(
    candidates,
    seed,
    ({ first, second }) => `${first.image}|${second.image}`,
  )
    .slice(0, count)
    .map((pair, index) => ({ id: `look-${index + 1}`, ...pair }));
}

export function raterSheet(
  pairs: BlindPair[],
  rater: Rater,
  seed: string,
): SheetItem[] {
  const raterSeed = `${seed}\0${rater.name}`;
  const items = pairs.flatMap((pair): SheetItem[] => {
    const firstOnLeft = coinFlip(raterSeed, pair.id);
    const [left, right] = firstOnLeft
      ? [pair.first, pair.second]
      : [pair.second, pair.first];
    const shown = { pairId: pair.id, left, right };
    return rater.kind === "human"
      ? [{ itemId: `${pair.id}-1`, ...shown }]
      : [
          { itemId: `${pair.id}-1`, ...shown },
          { itemId: `${pair.id}-2`, pairId: pair.id, left: right, right: left },
        ];
  });
  return seededShuffle(items, raterSeed, ({ itemId }) => itemId).map(
    (item, index) => ({
      ...item,
      itemId: seededScore(raterSeed, item.itemId).slice(0, 8) + index,
    }),
  );
}

export function parseRaters(
  humans: string | undefined,
  llmJudges: string | undefined,
): Rater[] {
  const named = (list: string | undefined, kind: RaterKind): Rater[] =>
    (list ?? "")
      .split(",")
      .filter(Boolean)
      .map((name) => ({ name, kind }));
  const raters = [...named(humans, "human"), ...named(llmJudges, "llm")];
  if (raters.length === 0) throw new Error("name at least one rater");
  const names = new Set<string>();
  for (const { name } of raters) {
    if (!SAFE_RATER_NAME.test(name)) {
      throw new Error(`invalid rater name: ${JSON.stringify(name)}`);
    }
    if (names.has(name)) throw new Error(`rater named twice: ${name}`);
    names.add(name);
  }
  return raters;
}

const SHEET_QUESTION: Record<PairMode, string> = {
  preference: "which would you ship?",
  look: "same look, or a different look?",
};
const SHEET_ANSWERS: Record<PairMode, [string, string][]> = {
  preference: [
    ["left", "Left"],
    ["right", "Right"],
  ],
  look: [
    ["same", "Same look"],
    ["different", "Different look"],
  ],
};

export function renderSheet(sheet: {
  rater: string;
  mode: PairMode;
  items: { itemId: string; leftImage: string; rightImage: string }[];
}): string {
  const answers = SHEET_ANSWERS[sheet.mode]
    .map(
      ([value, text]) =>
        `<label><input type="radio" value="${value}"> ${text}</label>`,
    )
    .join(" ");
  const rows = sheet.items
    .map(
      (item, index) => `<section data-item="${item.itemId}">
  <h2>${index + 1} of ${sheet.items.length}: ${SHEET_QUESTION[sheet.mode]}</h2>
  <div class="pair"><img alt="Left page" src="${item.leftImage}"><img alt="Right page" src="${item.rightImage}"></div>
  <p>${answers}</p>
</section>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Blind pairs for ${sheet.rater}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 1rem; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
img { width: 100%; border: 1px solid #888; }
section { margin-bottom: 3rem; }
label { margin-right: 1.5rem; }
</style>
</head>
<body>
<h1>Blind pairs for ${sheet.rater}</h1>
<p>Answer every pair, then save your answers and send the file back.</p>
${rows}
<button id="save" type="button">Save answers</button>
<p id="status" role="status"></p>
<script>
for (const section of document.querySelectorAll("section")) {
  for (const input of section.querySelectorAll("input")) input.name = section.dataset.item;
}
document.querySelector("#save").addEventListener("click", () => {
  const sections = [...document.querySelectorAll("section")];
  const choices = sections.flatMap((section) => {
    const picked = section.querySelector("input:checked");
    return picked ? [{ itemId: section.dataset.item, picked: picked.value }] : [];
  });
  document.querySelector("#status").textContent = choices.length + " of " + sections.length + " answered";
  const file = new Blob([JSON.stringify({ rater: ${JSON.stringify(sheet.rater)}, choices })], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = ${JSON.stringify(`answers-${sheet.rater}.json`)};
  link.click();
});
</script>
</body>
</html>
`;
}

function itemsOf(key: PairKey, verdict: HumanVerdict) {
  const rater = key.raters[verdict.rater];
  if (!rater) throw new Error(`no sheet for rater ${verdict.rater}`);
  const items = new Map(rater.items.map((item) => [item.itemId, item]));
  return verdict.choices.map(({ itemId, picked }) => {
    const item = items.get(itemId);
    if (!item) throw new Error(`unknown item ${itemId} from ${verdict.rater}`);
    return { item, picked };
  });
}

function pickedArm(item: SheetItem, picked: string): Arm {
  return picked === "left" ? item.left.arm : item.right.arm;
}

export function tallyPreference(key: PairKey, verdicts: HumanVerdict[]) {
  const perRater: Record<string, { C: number; A: number }> = {};
  const llmJudge: Record<
    string,
    { C: number; A: number; flippedWithOrder: number }
  > = {};
  for (const verdict of verdicts) {
    const answers = itemsOf(key, verdict);
    const counts = { C: 0, A: 0 };
    const armsByPair = new Map<string, Arm[]>();
    for (const { item, picked } of answers) {
      const arm = pickedArm(item, picked);
      if (arm === "A" || arm === "C") counts[arm] += 1;
      armsByPair.set(item.pairId, [
        ...(armsByPair.get(item.pairId) ?? []),
        arm,
      ]);
    }
    if (key.raters[verdict.rater]?.kind === "llm") {
      llmJudge[verdict.rater] = {
        ...counts,
        flippedWithOrder: [...armsByPair.values()].filter(
          (arms) => arms.length === 2 && arms[0] !== arms[1],
        ).length,
      };
    } else {
      perRater[verdict.rater] = counts;
    }
  }
  const raterCounts = Object.values(perRater);
  const C = raterCounts.reduce((sum, counts) => sum + counts.C, 0);
  const A = raterCounts.reduce((sum, counts) => sum + counts.A, 0);
  return {
    perRater,
    llmJudge,
    // Repeat votes from one rater are not independent, so this p is optimistic.
    preference: { C, A, p: binomialTwoSidedP(C, C + A) },
  };
}

export function tallyLook(
  key: PairKey,
  verdicts: HumanVerdict[],
  distanceOf: (pair: {
    id: string;
    first: PairBuild;
    second: PairBuild;
  }) => number,
) {
  const votes = new Map<
    string,
    { pair: SheetItem; different: number; same: number }
  >();
  for (const verdict of verdicts) {
    if (key.raters[verdict.rater]?.kind === "llm") continue;
    for (const { item, picked } of itemsOf(key, verdict)) {
      const entry = votes.get(item.pairId) ?? {
        pair: item,
        different: 0,
        same: 0,
      };
      if (picked === "different") entry.different += 1;
      else entry.same += 1;
      votes.set(item.pairId, entry);
    }
  }
  const labelled = [...votes.entries()]
    .filter(([, { different, same }]) => different !== same)
    .map(([id, { pair, different, same }]) => ({
      distance: distanceOf({ id, first: pair.left, second: pair.right }),
      different: different > same,
    }));
  return {
    pairs: labelled.length,
    tiedPairsLeftOut: votes.size - labelled.length,
    auc: rocAuc(labelled),
    validation: "light",
  };
}

function blindDirectory(label: string, mode: PairMode): string {
  return join(EVAL_ROOT, "results", "blind", `${label}-${mode}`);
}

function capturedBuilds(label: string): PairBuild[] {
  return loadCaptures(label)
    .filter(({ signature }) => signature !== null)
    .map(({ capture: { brief, arm, repeat } }) => ({
      brief,
      arm,
      repeat,
      image: join(
        capturesDirectory(label),
        brief,
        `${arm}-${repeat}`,
        screenshotFile(DESKTOP_WIDTH),
      ),
    }));
}

function writeRaterFolder(
  directory: string,
  rater: Rater,
  mode: PairMode,
  items: SheetItem[],
): void {
  const folder = join(directory, rater.name);
  const images = join(folder, "img");
  mkdirSync(images, { recursive: true });
  const copyOpaque = (source: string): string => {
    const name = `${seededScore(rater.name, source).slice(0, OPAQUE_NAME_LENGTH)}.png`;
    copyFileSync(source, join(images, name));
    return `img/${name}`;
  };
  writeFileSync(
    join(folder, "index.html"),
    renderSheet({
      rater: rater.name,
      mode,
      items: items.map((item) => ({
        itemId: item.itemId,
        leftImage: copyOpaque(item.left.image),
        rightImage: copyOpaque(item.right.image),
      })),
    }),
  );
}

function makeSheets(options: {
  label: string;
  mode: PairMode;
  seed: string;
  raters: Rater[];
  count: number;
}): void {
  const builds = capturedBuilds(options.label);
  const pairs =
    options.mode === "preference"
      ? planPreferencePairs(builds, options.seed)
      : planLookPairs(builds, options.seed, options.count);
  const directory = blindDirectory(options.label, options.mode);
  const key: PairKey = { mode: options.mode, raters: {} };
  for (const rater of options.raters) {
    const items = raterSheet(pairs, rater, options.seed);
    key.raters[rater.name] = { kind: rater.kind, items };
    writeRaterFolder(directory, rater, options.mode, items);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "key.json"),
    `${JSON.stringify(key, null, 2)}\n`,
  );
  console.log(
    `${pairs.length} pairs for ${options.raters.length} raters: ${directory}`,
  );
  console.log("Send a rater only their own folder. key.json reveals the arms.");
}

function imageDistance(pair: { first: PairBuild; second: PairBuild }): number {
  const signatureOf = ({ image }: PairBuild) =>
    screenshotSignature(decodePng(readFileSync(image)));
  return screenshotDistance(signatureOf(pair.first), signatureOf(pair.second));
}

function tally(label: string, mode: PairMode, answerFiles: string[]): void {
  const directory = blindDirectory(label, mode);
  const key = JSON.parse(
    readFileSync(join(directory, "key.json"), "utf8"),
  ) as PairKey;
  const verdicts = answerFiles.map(
    (file) => JSON.parse(readFileSync(file, "utf8")) as HumanVerdict,
  );
  const result =
    mode === "preference"
      ? tallyPreference(key, verdicts)
      : tallyLook(key, verdicts, imageDistance);
  const output = join(directory, "tally.json");
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`results: ${output}`);
}

function parseMode(value: string | undefined): PairMode {
  if (value === "preference" || value === "look") return value;
  throw new Error("--mode must be preference or look");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: "string" },
      mode: { type: "string" },
      seed: { type: "string" },
      raters: { type: "string" },
      "llm-judges": { type: "string" },
      count: { type: "string", default: String(DEFAULT_LOOK_PAIRS) },
    },
  });
  const [command, ...answerFiles] = positionals;
  if (!values.label) throw new Error("--label is required");
  const mode = parseMode(values.mode);
  if (command === "make") {
    if (!values.seed) throw new Error("--seed is required");
    makeSheets({
      label: values.label,
      mode,
      seed: values.seed,
      raters: parseRaters(values.raters, values["llm-judges"]),
      count: Number(values.count),
    });
  } else if (command === "tally") {
    tally(values.label, mode, answerFiles);
  } else {
    throw new Error(
      "usage: blind-pairs <make|tally> --label <label> --mode <mode>",
    );
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
