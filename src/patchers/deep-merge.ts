export type MergeValue =
  | string
  | number
  | boolean
  | null
  | MergeValue[]
  | { [key: string]: MergeValue };

function isMergeObject(
  value: MergeValue,
): value is { [key: string]: MergeValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value: MergeValue): MergeValue {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }

  if (isMergeObject(value)) {
    const cloned: { [key: string]: MergeValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneValue(entry);
    }
    return cloned;
  }

  return value;
}

export function mergeValues(base: MergeValue, update: MergeValue): MergeValue {
  if (!isMergeObject(base) || !isMergeObject(update)) {
    return cloneValue(update);
  }

  const merged: { [key: string]: MergeValue } = {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = cloneValue(value);
  }

  for (const [key, value] of Object.entries(update)) {
    const current = merged[key];
    if (
      current !== undefined &&
      isMergeObject(current) &&
      isMergeObject(value)
    ) {
      merged[key] = mergeValues(current, value);
      continue;
    }

    merged[key] = cloneValue(value);
  }

  return merged;
}
