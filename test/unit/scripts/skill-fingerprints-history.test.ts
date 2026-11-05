import { describe, expect, it } from "vitest";
import {
  addFingerprint,
  historyFromRecord,
  historyToRecord,
  mergeInto,
} from "../../../scripts/skill-fingerprints/history.js";

const OLD_PINNED_FINGERPRINT =
  "704b816d2449e11d04327b17b4bdebce8a8787e59b4a7a05e6ee8ba48fec2237";
const NEW_BUNDLED_FINGERPRINT = "a".repeat(64);

describe("skill fingerprint history", () => {
  it("keeps every existing entry when newly computed fingerprints are merged in", () => {
    const history = historyFromRecord({
      "web-design-guidelines": [OLD_PINNED_FINGERPRINT],
    });
    const computedFromWorkingTree = new Map([
      ["web-design-guidelines", new Set([NEW_BUNDLED_FINGERPRINT])],
    ]);

    mergeInto(history, computedFromWorkingTree);

    expect(historyToRecord(history)).toEqual({
      "web-design-guidelines": [
        OLD_PINNED_FINGERPRINT,
        NEW_BUNDLED_FINGERPRINT,
      ],
    });
  });

  it("keeps a skill that is no longer computed from anything", () => {
    const history = historyFromRecord({
      "writing-guidelines": [OLD_PINNED_FINGERPRINT],
    });

    addFingerprint(history, "agemon-commit", NEW_BUNDLED_FINGERPRINT);

    expect(Object.keys(historyToRecord(history))).toEqual([
      "agemon-commit",
      "writing-guidelines",
    ]);
  });
});
