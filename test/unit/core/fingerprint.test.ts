import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fingerprintContent,
  fingerprintJson,
  sha256Hex,
} from "../../../src/core/fingerprint.js";

function referenceSha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

describe("fingerprint", () => {
  it("hashes raw content with sha256", () => {
    expect(fingerprintContent("hello world")).toBe(
      referenceSha256("hello world"),
    );
    expect(sha256Hex("")).toBe(referenceSha256(""));
  });

  it("is stable across key ordering for JSON", () => {
    const first = fingerprintJson({ b: 1, a: { d: 4, c: 3 } });
    const second = fingerprintJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(first).toBe(second);
  });

  it("still distinguishes different JSON values", () => {
    expect(fingerprintJson({ a: 1 })).not.toBe(fingerprintJson({ a: 2 }));
  });

  it("ignores undefined properties when canonicalising", () => {
    expect(fingerprintJson({ a: 1, b: undefined })).toBe(
      fingerprintJson({ a: 1 }),
    );
  });
});
