import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const PNG_RGB = 2;
const PNG_RGBA = 6;
const PNG_BYTES_PER_CHANNEL = 1;
const PNG_NON_INTERLACED = 0;

// The first three desktop viewports, as a share of width: pages differ in length, and comparing
// only a fixed crop stops length alone from reading as distance.
const CROP_ASPECT = 2700 / 1440;
const GRID_COLUMNS = 48;
const GRID_ROWS = Math.round(GRID_COLUMNS * CROP_ASPECT);
const HISTOGRAM_LEVELS = 4;
const HISTOGRAM_BINS = HISTOGRAM_LEVELS ** 3;
const OFF_PAGE_LUMA = 255;

const APPROPRIATENESS_TOLERANCE_POINTS = 2;
const SIGNIFICANCE_LEVEL = 0.05;

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

export interface ScreenshotSignature {
  luma: number[];
  histogram: number[];
}

export interface PassRuleInput {
  distance: { A: number | null; C: number | null };
  tells: { A: number | null; C: number | null };
  appropriateness: { A: number | null; C: number | null };
  preference: { C: number; A: number; p: number | null } | null;
}

export type PassRuleOutcome = "pass" | "fail" | "pending";

export function decodePng(file: Buffer): DecodedPng {
  if (file.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error("not a PNG file");
  }
  let offset = 8;
  let header: Buffer | undefined;
  const compressed: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = data;
    if (type === "IDAT") compressed.push(data);
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no header");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = channelCount(header);
  return {
    width,
    height,
    channels,
    pixels: unfilter(
      inflateSync(Buffer.concat(compressed)),
      width,
      height,
      channels,
    ),
  };
}

function channelCount(header: Buffer): number {
  const [bitDepth, colorType, , , interlace] = header.subarray(8);
  const isSupported =
    bitDepth === 8 * PNG_BYTES_PER_CHANNEL &&
    (colorType === PNG_RGB || colorType === PNG_RGBA) &&
    interlace === PNG_NON_INTERLACED;
  if (!isSupported) throw new Error("unsupported PNG format");
  return colorType === PNG_RGB ? 3 : 4;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftGap = Math.abs(estimate - left);
  const upGap = Math.abs(estimate - up);
  const upLeftGap = Math.abs(estimate - upLeft);
  if (leftGap <= upGap && leftGap <= upLeftGap) return left;
  return upGap <= upLeftGap ? up : upLeft;
}

function predictedByte(
  filter: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paethPredictor(left, up, upLeft);
    default:
      throw new Error("unknown PNG row filter");
  }
}

function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const rawStart = row * (stride + 1);
    const filter = raw[rawStart];
    const pixelStart = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const left =
        index >= channels
          ? (pixels[pixelStart + index - channels] as number)
          : 0;
      const up = row > 0 ? (pixels[pixelStart + index - stride] as number) : 0;
      const upLeft =
        row > 0 && index >= channels
          ? (pixels[pixelStart + index - stride - channels] as number)
          : 0;
      const predicted = predictedByte(filter as number, left, up, upLeft);
      pixels[pixelStart + index] =
        ((raw[rawStart + 1 + index] as number) + predicted) & 0xff;
    }
  }
  return pixels;
}

function lumaOf(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

export function screenshotSignature(image: DecodedPng): ScreenshotSignature {
  const cropHeight = Math.round(image.width * CROP_ASPECT);
  const lumaSums = new Float64Array(GRID_COLUMNS * GRID_ROWS);
  const lumaCounts = new Uint32Array(GRID_COLUMNS * GRID_ROWS);
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  const visibleRows = Math.min(image.height, cropHeight);
  for (let y = 0; y < visibleRows; y += 1) {
    const gridRow = Math.floor((y / cropHeight) * GRID_ROWS);
    for (let x = 0; x < image.width; x += 1) {
      const start = (y * image.width + x) * image.channels;
      const red = image.pixels[start] as number;
      const green = image.pixels[start + 1] as number;
      const blue = image.pixels[start + 2] as number;
      const cell =
        gridRow * GRID_COLUMNS + Math.floor((x / image.width) * GRID_COLUMNS);
      lumaSums[cell] = (lumaSums[cell] as number) + lumaOf(red, green, blue);
      lumaCounts[cell] = (lumaCounts[cell] as number) + 1;
      const level = (channel: number) =>
        Math.floor((channel / 256) * HISTOGRAM_LEVELS);
      const bin =
        level(red) * HISTOGRAM_LEVELS ** 2 +
        level(green) * HISTOGRAM_LEVELS +
        level(blue);
      histogram[bin] = (histogram[bin] as number) + 1;
    }
  }
  const counted = histogram.reduce((sum, count) => sum + count, 0) || 1;
  return {
    luma: [...lumaSums].map((sum, cell) =>
      lumaCounts[cell] ? sum / (lumaCounts[cell] as number) : OFF_PAGE_LUMA,
    ),
    histogram: histogram.map((count) => count / counted),
  };
}

function pearsonCorrelation(first: number[], second: number[]): number | null {
  const meanOf = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const firstMean = meanOf(first);
  const secondMean = meanOf(second);
  let shared = 0;
  let firstSpread = 0;
  let secondSpread = 0;
  for (const [index, value] of first.entries()) {
    const firstGap = value - firstMean;
    const secondGap = (second[index] as number) - secondMean;
    shared += firstGap * secondGap;
    firstSpread += firstGap ** 2;
    secondSpread += secondGap ** 2;
  }
  if (firstSpread === 0 || secondSpread === 0) return null;
  return shared / Math.sqrt(firstSpread * secondSpread);
}

function structureDistance(first: number[], second: number[]): number {
  const correlation = pearsonCorrelation(first, second);
  if (correlation !== null) return (1 - correlation) / 2;
  // A flat page has no structure to correlate, so only an equally flat one of the same tone matches.
  const meanGap =
    first.reduce((sum, value, index) => {
      return sum + Math.abs(value - (second[index] as number));
    }, 0) / first.length;
  return meanGap === 0 ? 0 : 0.5;
}

function colorDistance(first: number[], second: number[]): number {
  return (
    first.reduce(
      (sum, share, bin) => sum + Math.abs(share - (second[bin] as number)),
      0,
    ) / 2
  );
}

// Dependency-free stand-in for an embedding distance: half layout, half colour, both 0 to 1.
export function screenshotDistance(
  first: ScreenshotSignature,
  second: ScreenshotSignature,
): number {
  return (
    (structureDistance(first.luma, second.luma) +
      colorDistance(first.histogram, second.histogram)) /
    2
  );
}

export function meanPairwiseDistance(
  signatures: ScreenshotSignature[],
): number | null {
  let total = 0;
  let pairs = 0;
  for (const [index, first] of signatures.entries()) {
    for (const second of signatures.slice(index + 1)) {
      total += screenshotDistance(first, second);
      pairs += 1;
    }
  }
  return pairs === 0 ? null : total / pairs;
}

export function paletteEntropy(palette: { count: number }[]): number {
  const total = palette.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) return 0;
  const bits = palette.reduce((sum, { count }) => {
    const share = count / total;
    return share === 0 ? sum : sum - share * Math.log2(share);
  }, 0);
  return bits === 0 ? 0 : bits;
}

export function layoutHash(tokens: string[]): string {
  return createHash("sha256")
    .update(tokens.join("|"))
    .digest("hex")
    .slice(0, 12);
}

export function topValueShare(
  values: string[],
): { value: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const top = [...counts].sort((left, right) => right[1] - left[1])[0];
  return top ? { value: top[0], share: top[1] / values.length } : null;
}

export function rocAuc(
  labelled: { distance: number; different: boolean }[],
): number | null {
  const different = labelled.filter((entry) => entry.different);
  const same = labelled.filter((entry) => !entry.different);
  if (different.length === 0 || same.length === 0) return null;
  let wins = 0;
  for (const high of different) {
    for (const low of same) {
      if (high.distance > low.distance) wins += 1;
      else if (high.distance === low.distance) wins += 0.5;
    }
  }
  return wins / (different.length * same.length);
}

function binomialProbability(successes: number, trials: number): number {
  let logProbability = -trials * Math.LN2;
  for (let step = 1; step <= successes; step += 1) {
    logProbability += Math.log((trials - step + 1) / step);
  }
  return Math.exp(logProbability);
}

export function binomialTwoSidedP(
  successes: number,
  trials: number,
): number | null {
  if (trials === 0) return null;
  const observed = binomialProbability(successes, trials);
  let total = 0;
  for (let count = 0; count <= trials; count += 1) {
    const probability = binomialProbability(count, trials);
    if (probability <= observed * (1 + 1e-9)) total += probability;
  }
  return Math.min(1, total);
}

function compareWhenKnown(
  first: number | null,
  second: number | null,
  holds: (first: number, second: number) => boolean,
): boolean | null {
  return first === null || second === null ? null : holds(first, second);
}

export function applyPassRule(input: PassRuleInput) {
  const distanceBeatsA = compareWhenKnown(
    input.distance.C,
    input.distance.A,
    (c, a) => c > a,
  );
  const tellsBeatA = compareWhenKnown(
    input.tells.C,
    input.tells.A,
    (c, a) => c < a,
  );
  const appropriatenessWithinTwo = compareWhenKnown(
    input.appropriateness.C,
    input.appropriateness.A,
    (c, a) => a - c <= APPROPRIATENESS_TOLERANCE_POINTS,
  );
  const { preference } = input;
  const preferenceNotBelowA =
    preference === null || preference.p === null
      ? null
      : !(preference.C < preference.A && preference.p < SIGNIFICANCE_LEVEL);
  const conditions = [
    distanceBeatsA,
    tellsBeatA,
    appropriatenessWithinTwo,
    preferenceNotBelowA,
  ];
  const outcome: PassRuleOutcome = conditions.includes(false)
    ? "fail"
    : conditions.includes(null)
      ? "pending"
      : "pass";
  return {
    distanceBeatsA,
    tellsBeatA,
    appropriatenessWithinTwo,
    preferenceNotBelowA,
    outcome,
  };
}
