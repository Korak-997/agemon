export type Random = () => number;

export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickFrom<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

export function integerBetween(
  random: Random,
  low: number,
  high: number,
): number {
  return low + Math.floor(random() * (high - low + 1));
}
