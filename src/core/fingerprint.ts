import { createHash } from "node:crypto";

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }

  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      sortedEntries.map(([key, entryValue]) => [
        key,
        canonicalizeJsonValue(entryValue),
      ]),
    );
  }

  return value;
}

export function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export function fingerprintJson(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalizeJsonValue(value)));
}

export function fingerprintContent(contents: string): string {
  return sha256Hex(contents);
}
