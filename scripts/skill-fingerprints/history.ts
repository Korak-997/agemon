export type FingerprintsByName = Map<string, Set<string>>;

function byCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function addFingerprint(
  target: FingerprintsByName,
  skillName: string,
  fingerprint: string,
): void {
  const fingerprints = target.get(skillName) ?? new Set<string>();
  fingerprints.add(fingerprint);
  target.set(skillName, fingerprints);
}

export function mergeInto(
  target: FingerprintsByName,
  source: FingerprintsByName,
): void {
  for (const [skillName, fingerprints] of source) {
    for (const fingerprint of fingerprints) {
      addFingerprint(target, skillName, fingerprint);
    }
  }
}

export function historyFromRecord(
  record: Readonly<Record<string, readonly string[]>>,
): FingerprintsByName {
  const history: FingerprintsByName = new Map();
  for (const [skillName, fingerprints] of Object.entries(record)) {
    for (const fingerprint of fingerprints) {
      addFingerprint(history, skillName, fingerprint);
    }
  }
  return history;
}

export function historyToRecord(
  history: FingerprintsByName,
): Record<string, string[]> {
  return Object.fromEntries(
    [...history]
      .map(([skillName, fingerprints]): [string, string[]] => [
        skillName,
        [...fingerprints].sort(byCodeUnit),
      ])
      .sort(([left], [right]) => byCodeUnit(left, right)),
  );
}
