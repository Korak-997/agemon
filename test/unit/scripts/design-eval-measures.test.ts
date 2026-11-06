import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type HumanVerdict,
  type PairKey,
  parseRaters,
  planLookPairs,
  planPreferencePairs,
  raterSheet,
  renderSheet,
  tallyLook,
  tallyPreference,
} from "../../../scripts/design-eval/blind-pairs.js";
import {
  type BuildCapture,
  buildAppropriateness,
  buildFingerprint,
  scoreAcceptanceSource,
} from "../../../scripts/design-eval/capture.js";
import {
  applyPassRule,
  binomialTwoSidedP,
  decodePng,
  layoutHash,
  meanPairwiseDistance,
  paletteEntropy,
  rocAuc,
  screenshotDistance,
  screenshotSignature,
  topValueShare,
} from "../../../scripts/design-eval/measures.js";
import { summariseCaptures } from "../../../scripts/design-eval/score.js";

const fingerprintSource = readFileSync(
  join(import.meta.dirname, "../../../scripts/design-eval/page-fingerprint.js"),
  "utf8",
);
const { detectTells } = runInNewContext(fingerprintSource);

type Rgb = [number, number, number];

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([
    length,
    Buffer.from(type, "latin1"),
    data,
    Buffer.alloc(4),
  ]);
}

function encodePng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => Rgb,
  filter = 0,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(filter);
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelAt(x, y);
      const left = x > 0 && filter === 1 ? pixelAt(x - 1, y) : [0, 0, 0];
      const up = y > 0 && filter === 2 ? pixelAt(x, y - 1) : [0, 0, 0];
      for (const channel of [0, 1, 2]) {
        rows.push(
          ((pixel[channel] as number) -
            (left[channel] as number) -
            (up[channel] as number) +
            512) %
            256,
        );
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const WHITE: Rgb = [255, 255, 255];
const NAVY: Rgb = [10, 20, 90];

function page(pixelAt: (x: number, y: number) => Rgb) {
  return screenshotSignature(decodePng(encodePng(144, 270, pixelAt)));
}

const leftColumnPage = page((x) => (x < 72 ? NAVY : WHITE));
const topBandPage = page((_, y) => (y < 135 ? NAVY : WHITE));
const whitePage = page(() => WHITE);

describe("decodePng", () => {
  it.each([0, 1, 2])("reads RGB pixels under filter %i", (filter) => {
    const pixelAt = (x: number, y: number): Rgb => [x * 40, y * 40, 7];
    const image = decodePng(encodePng(4, 3, pixelAt, filter));
    expect(image).toMatchObject({ width: 4, height: 3, channels: 3 });
    expect([
      ...image.pixels.subarray((2 * 4 + 3) * 3, (2 * 4 + 4) * 3),
    ]).toEqual([120, 80, 7]);
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/PNG/u);
  });
});

describe("screenshotDistance", () => {
  it("is 0 for identical pages, and symmetric", () => {
    expect(screenshotDistance(leftColumnPage, leftColumnPage)).toBeCloseTo(0);
    expect(screenshotDistance(leftColumnPage, topBandPage)).toBeCloseTo(
      screenshotDistance(topBandPage, leftColumnPage),
    );
  });

  it("separates layouts with the same colours", () => {
    expect(screenshotDistance(leftColumnPage, topBandPage)).toBeGreaterThan(
      0.2,
    );
  });

  it("separates a colour change at the same layout", () => {
    const redColumnPage = page((x) => (x < 72 ? [200, 30, 30] : WHITE));
    const distance = screenshotDistance(leftColumnPage, redColumnPage);
    expect(distance).toBeGreaterThan(0.1);
    expect(distance).toBeLessThan(
      screenshotDistance(leftColumnPage, topBandPage) + 0.2,
    );
  });

  it("stays finite on a page with no variation", () => {
    const distance = screenshotDistance(whitePage, leftColumnPage);
    expect(distance).toBeGreaterThan(0);
    expect(screenshotDistance(whitePage, whitePage)).toBeCloseTo(0);
  });

  it("compares only the crop, so extra page length does not count", () => {
    const shortPage = page(() => WHITE);
    const longPage = screenshotSignature(
      decodePng(encodePng(144, 1000, (_, y) => (y > 300 ? NAVY : WHITE))),
    );
    expect(screenshotDistance(shortPage, longPage)).toBeLessThan(0.05);
  });
});

describe("meanPairwiseDistance", () => {
  it("averages every pair within the group", () => {
    const all = [leftColumnPage, topBandPage, whitePage];
    const expected =
      (screenshotDistance(leftColumnPage, topBandPage) +
        screenshotDistance(leftColumnPage, whitePage) +
        screenshotDistance(topBandPage, whitePage)) /
      3;
    expect(meanPairwiseDistance(all)).toBeCloseTo(expected);
  });

  it("is null with fewer than 2 builds, not 0", () => {
    expect(meanPairwiseDistance([whitePage])).toBeNull();
  });
});

describe("fingerprint helpers", () => {
  it("palette entropy is 0 for one colour and rises with an even spread", () => {
    expect(paletteEntropy([{ count: 9 }])).toBe(0);
    expect(paletteEntropy([{ count: 5 }, { count: 5 }])).toBeCloseTo(1);
    expect(paletteEntropy([])).toBe(0);
  });

  it("layout hash ignores token order only where order is not layout", () => {
    expect(layoutHash(["0-12", "0-4,4-8,8-12"])).toBe(
      layoutHash(["0-12", "0-4,4-8,8-12"]),
    );
    expect(layoutHash(["0-12", "0-6,6-12"])).not.toBe(
      layoutHash(["0-6,6-12", "0-12"]),
    );
  });

  it("topValueShare reports the commonest value's share", () => {
    expect(topValueShare(["a", "a", "b", "a"])).toEqual({
      value: "a",
      share: 0.75,
    });
    expect(topValueShare([])).toBeNull();
  });
});

describe("rocAuc", () => {
  it("is 1 when every different pair scores above every same pair", () => {
    expect(
      rocAuc([
        { distance: 0.1, different: false },
        { distance: 0.2, different: false },
        { distance: 0.5, different: true },
      ]),
    ).toBe(1);
  });

  it("is 0.5 on ties and null without both labels", () => {
    expect(
      rocAuc([
        { distance: 0.3, different: false },
        { distance: 0.3, different: true },
      ]),
    ).toBe(0.5);
    expect(rocAuc([{ distance: 0.3, different: true }])).toBeNull();
  });
});

describe("binomialTwoSidedP", () => {
  it("matches the plan's figure for 21 of 30", () => {
    expect(binomialTwoSidedP(21, 30)).toBeCloseTo(0.043, 2);
  });

  it("is 1 for an even split and symmetric", () => {
    expect(binomialTwoSidedP(5, 10)).toBe(1);
    expect(binomialTwoSidedP(3, 20)).toBe(binomialTwoSidedP(17, 20));
  });

  it("is null with no votes", () => {
    expect(binomialTwoSidedP(0, 0)).toBeNull();
  });
});

describe("applyPassRule", () => {
  const passing = {
    distance: { A: 0.3, C: 0.4 },
    tells: { A: 4, C: 2 },
    appropriateness: { A: 6, C: 5 },
    preference: { C: 15, A: 15, p: 1 },
  };

  it("passes only when all four conditions hold", () => {
    expect(applyPassRule(passing)).toMatchObject({
      distanceBeatsA: true,
      tellsBeatA: true,
      appropriatenessWithinTwo: true,
      preferenceNotBelowA: true,
      outcome: "pass",
    });
  });

  it.each([
    ["no more distinct", { distance: { A: 0.4, C: 0.4 } }],
    ["no fewer tells", { tells: { A: 2, C: 2 } }],
    [
      "appropriateness down by more than 2",
      { appropriateness: { A: 7, C: 4.9 } },
    ],
    [
      "significantly preferred less",
      { preference: { C: 5, A: 25, p: 0.0003 } },
    ],
  ])("fails when %s", (_, change) => {
    expect(applyPassRule({ ...passing, ...change }).outcome).toBe("fail");
  });

  it("allows appropriateness exactly 2 lower", () => {
    expect(
      applyPassRule({ ...passing, appropriateness: { A: 7, C: 5 } }).outcome,
    ).toBe("pass");
  });

  it("does not fail on a non-significant preference for A", () => {
    expect(
      applyPassRule({ ...passing, preference: { C: 12, A: 18, p: 0.36 } })
        .outcome,
    ).toBe("pass");
  });

  it("stays pending without human votes, and a measure failure still fails", () => {
    expect(applyPassRule({ ...passing, preference: null }).outcome).toBe(
      "pending",
    );
    expect(
      applyPassRule({
        ...passing,
        preference: null,
        tells: { A: 1, C: 3 },
      }).outcome,
    ).toBe("fail");
  });

  it("stays pending when a measure is missing, never passing on nothing", () => {
    expect(
      applyPassRule({ ...passing, distance: { A: null, C: 0.4 } }).outcome,
    ).toBe("pending");
  });
});

describe("detectTells", () => {
  const plainFacts = {
    pageBackground: { r: 255, g: 255, b: 255 },
    textColor: { r: 0, g: 0, b: 0 },
    headingIsSerif: false,
    saturatedHues: 0,
    hairlines: 0,
    denseColumns: 0,
    distinctRadii: 2,
    identicalCards: 0,
    identicalShadowedCards: 0,
    labelsAboveHeadings: 0,
    separatorStrings: 0,
    monoLabels: 0,
    arrowLinks: 0,
    numberedMarkers: 0,
    headlineEmphasis: 0,
    bigNumberHero: false,
    gradientWashes: 0,
  };

  function firedTells(changes: object): string[] {
    const tells = detectTells({ ...plainFacts, ...changes });
    return Object.keys(tells).filter((name) => tells[name]);
  }

  it("finds nothing on a plain page", () => {
    expect(firedTells({})).toEqual([]);
  });

  it.each([
    [
      "creamSerifClay",
      { pageBackground: { r: 244, g: 241, b: 234 }, headingIsSerif: true },
    ],
    [
      "nearBlackOneAccent",
      { pageBackground: { r: 12, g: 12, b: 12 }, saturatedHues: 1 },
    ],
    ["broadsheet", { hairlines: 6, denseColumns: 1, distinctRadii: 0 }],
    ["saasCardKit", { identicalShadowedCards: 3 }],
    ["saasCardKit", { identicalCards: 3, distinctRadii: 1 }],
    ["trackedLabels", { labelsAboveHeadings: 2 }],
    ["separatorStrings", { separatorStrings: 1 }],
    ["tintedBlack", { textColor: { r: 28, g: 25, b: 20 } }],
    ["monoLabels", { monoLabels: 3 }],
    ["arrowLinks", { arrowLinks: 1 }],
    ["numberedMarkers", { numberedMarkers: 4 }],
    ["headlineEmphasis", { headlineEmphasis: 1 }],
    ["bigNumberHero", { bigNumberHero: true }],
    ["gradientWashes", { gradientWashes: 2 }],
  ])("reports %s", (name, changes) => {
    expect(firedTells(changes)).toContain(name);
  });

  it("leaves pure black and white out, and a three-step sequence unflagged", () => {
    expect(firedTells({ numberedMarkers: 3 })).toEqual([]);
    expect(
      firedTells({ pageBackground: { r: 0, g: 0, b: 0 }, saturatedHues: 2 }),
    ).toEqual([]);
  });
});

function capture(overrides: Partial<BuildCapture> = {}): BuildCapture {
  const view = {
    audit: {
      overflow: [],
      targets: [],
      contrast: [],
      notVerified: [],
      fonts: [{ family: "Lora", count: 3 }],
      palette: [
        { value: "#ffffff", count: 5 },
        { value: "#112233", count: 5 },
      ],
      radii: [{ value: "4px", count: 2 }],
      scan: { elements: 10, contrastChecked: 5, truncated: false },
    },
    fingerprint: {
      shadows: [{ value: "none", count: 1 }],
      layout: ["0-12"],
      paletteFamily: "neutral",
      tells: { arrowLinks: true, broadsheet: false },
    },
    consoleErrors: 0,
  };
  return {
    brief: "field-notes-greenfield",
    arm: "C",
    repeat: 1,
    page: "index.html",
    status: "rendered",
    views: { 1440: view, 375: view },
    acceptance: [
      { id: "hero", met: true },
      { id: "footer", met: false },
    ],
    placeholderCopy: false,
    ...overrides,
  };
}

describe("buildFingerprint", () => {
  it("summarises one build's desktop view and counts dated tells", () => {
    expect(buildFingerprint(capture())).toMatchObject({
      fonts: ["Lora"],
      paletteEntropy: 1,
      paletteFamily: "neutral",
      radii: ["4px"],
      shadows: ["none"],
      tellCount: 1,
    });
  });
});

describe("buildAppropriateness", () => {
  it("adds acceptance criteria and the three rendered floors", () => {
    expect(buildAppropriateness(capture())).toEqual({ points: 4, of: 5 });
  });

  it("loses a point for a rendered failure at any width", () => {
    const failing = capture();
    const narrow = failing.views[375];
    failing.views[375] = {
      ...narrow,
      audit: {
        ...narrow?.audit,
        overflow: [{ selector: "html", by: 40 }],
      },
    } as typeof narrow;
    expect(buildAppropriateness(failing).points).toBe(3);
  });

  it("does not credit an unrun placeholder check", () => {
    expect(
      buildAppropriateness(capture({ placeholderCopy: null })).points,
    ).toBe(3);
  });

  it("scores a build that never rendered as 0", () => {
    expect(
      buildAppropriateness(capture({ status: "not-rendered", views: {} }))
        .points,
    ).toBe(0);
  });
});

describe("scoreAcceptanceSource", () => {
  it("meets a source criterion only from product files", () => {
    expect(
      scoreAcceptanceSource(
        [{ id: "empty-state", sourcePattern: "no invoices" }],
        "const empty = 'No invoices yet'",
      ),
    ).toEqual([{ id: "empty-state", met: true }]);
    expect(
      scoreAcceptanceSource(
        [{ id: "empty-state", sourcePattern: "no invoices" }],
        "",
      ),
    ).toEqual([{ id: "empty-state", met: false }]);
  });
});

describe("summariseCaptures", () => {
  const entries = (["A", "C"] as const).flatMap((arm) =>
    [1, 2].map((repeat) => ({
      capture: capture({ arm, repeat }),
      signature:
        arm === "A" ? whitePage : repeat === 1 ? leftColumnPage : topBandPage,
    })),
  );

  it("measures distance within each brief and arm, never across arms", () => {
    const summary = summariseCaptures(entries);
    const brief = summary.briefs["field-notes-greenfield"];
    expect(brief?.A?.meanDistance).toBeCloseTo(0);
    expect(brief?.C?.meanDistance).toBeCloseTo(
      screenshotDistance(leftColumnPage, topBandPage),
    );
    expect(summary.arms.C?.meanDistance).toBeGreaterThan(
      summary.arms.A?.meanDistance as number,
    );
  });

  it("counts builds that never rendered as failed, and leaves them out of distance", () => {
    const summary = summariseCaptures([
      ...entries,
      {
        capture: capture({
          arm: "C",
          repeat: 3,
          status: "not-rendered",
          views: {},
        }),
        signature: null,
      },
    ]);
    const brief = summary.briefs["field-notes-greenfield"];
    expect(brief?.C).toMatchObject({ builds: 3, notRendered: 1 });
    expect(brief?.C?.meanDistance).toBeCloseTo(
      screenshotDistance(leftColumnPage, topBandPage),
    );
  });

  it("reports top font and palette family share per arm", () => {
    expect(summariseCaptures(entries).arms.C?.topFont).toEqual({
      value: "Lora",
      share: 1,
    });
    expect(summariseCaptures(entries).arms.C?.topPaletteFamily).toEqual({
      value: "neutral",
      share: 1,
    });
  });
});

const buildsPerBrief = (["field-notes", "tarn"] as const).flatMap((brief) =>
  (["A", "B", "C"] as const).flatMap((arm) =>
    [1, 2, 3].map((repeat) => ({
      brief,
      arm,
      repeat,
      image: `${brief}/${arm}-${repeat}.png`,
    })),
  ),
);

describe("blind pair planning", () => {
  it("matches each C with one A in the same brief and never uses B", () => {
    const pairs = planPreferencePairs(buildsPerBrief, "seed");
    expect(pairs).toHaveLength(6);
    for (const pair of pairs) {
      expect(pair.first.brief).toBe(pair.second.brief);
      expect([pair.first.arm, pair.second.arm].sort()).toEqual(["A", "C"]);
    }
    const usedImages = pairs.flatMap((pair) => [
      pair.first.image,
      pair.second.image,
    ]);
    expect(new Set(usedImages).size).toBe(usedImages.length);
  });

  it("is stable for a seed and differs across seeds", () => {
    const pairs = (seed: string) => planPreferencePairs(buildsPerBrief, seed);
    expect(pairs("x")).toEqual(pairs("x"));
    expect(pairs("x")).not.toEqual(pairs("y"));
  });

  it("plans look pairs within a brief up to the requested count", () => {
    const pairs = planLookPairs(buildsPerBrief, "seed", 20);
    expect(pairs).toHaveLength(20);
    for (const pair of pairs) expect(pair.first.brief).toBe(pair.second.brief);
    const keys = pairs.map((pair) =>
      [pair.first.image, pair.second.image].sort().join(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("raterSheet", () => {
  const pairs = planPreferencePairs(buildsPerBrief, "seed");

  it("randomises order and sides per rater", () => {
    const sides = (rater: string) =>
      raterSheet(pairs, { name: rater, kind: "human" }, "seed").map(
        (item) => `${item.pairId}:${item.left.arm}`,
      );
    expect(sides("ana")).not.toEqual(sides("ben"));
    expect(sides("ana")).toEqual(sides("ana"));
  });

  it("shows each pair in both orders to an LLM judge, once to a person", () => {
    const person = raterSheet(pairs, { name: "ana", kind: "human" }, "s");
    const judge = raterSheet(pairs, { name: "judge", kind: "llm" }, "s");
    expect(person).toHaveLength(pairs.length);
    expect(judge).toHaveLength(pairs.length * 2);
    for (const pair of pairs) {
      const shown = judge.filter((item) => item.pairId === pair.id);
      expect(shown.map((item) => item.left.image).sort()).toEqual(
        [pair.first.image, pair.second.image].sort(),
      );
    }
  });

  it("rendered pages do not reveal arm, brief or source path", () => {
    const sheet = raterSheet(pairs, { name: "ana", kind: "human" }, "s");
    const html = renderSheet({
      rater: "ana",
      mode: "preference",
      items: sheet.map((item, index) => ({
        itemId: item.itemId,
        leftImage: `img/${index}l.png`,
        rightImage: `img/${index}r.png`,
      })),
    });
    expect(html).toContain("which would you ship?");
    expect(html).not.toMatch(/arm|field-notes|tarn|-[123]\.png/iu);
  });
});

describe("parseRaters", () => {
  it("splits human and LLM names and rejects unsafe ones", () => {
    expect(parseRaters("ana,ben", "judge")).toEqual([
      { name: "ana", kind: "human" },
      { name: "ben", kind: "human" },
      { name: "judge", kind: "llm" },
    ]);
    expect(() => parseRaters("../evil", undefined)).toThrow(/rater name/u);
    expect(() => parseRaters("", undefined)).toThrow(/at least one/u);
    expect(() => parseRaters("ana,ana", undefined)).toThrow(/twice/u);
  });
});

describe("tallyPreference", () => {
  const pairs = planPreferencePairs(buildsPerBrief, "seed");
  const key: PairKey = {
    mode: "preference",
    raters: {
      ana: {
        kind: "human",
        items: raterSheet(pairs, { name: "ana", kind: "human" }, "s"),
      },
      ben: {
        kind: "human",
        items: raterSheet(pairs, { name: "ben", kind: "human" }, "s"),
      },
      judge: {
        kind: "llm",
        items: raterSheet(pairs, { name: "judge", kind: "llm" }, "s"),
      },
    },
  };

  function answersPicking(rater: string, arm: "A" | "C"): HumanVerdict {
    return {
      rater,
      choices: (key.raters[rater]?.items ?? []).map((item) => ({
        itemId: item.itemId,
        picked: item.left.arm === arm ? "left" : "right",
      })),
    };
  }

  it("resolves sides to arms and keeps per-rater results", () => {
    const tally = tallyPreference(key, [
      answersPicking("ana", "C"),
      answersPicking("ben", "A"),
    ]);
    expect(tally.perRater).toEqual({
      ana: { C: 6, A: 0 },
      ben: { C: 0, A: 6 },
    });
    expect(tally.preference).toMatchObject({ C: 6, A: 6, p: 1 });
  });

  it("records an LLM judge separately and never counts it", () => {
    const tally = tallyPreference(key, [
      answersPicking("ana", "A"),
      answersPicking("judge", "C"),
    ]);
    expect(tally.preference).toMatchObject({ C: 0, A: 6 });
    expect(tally.llmJudge.judge).toEqual({ C: 12, A: 0, flippedWithOrder: 0 });
  });

  it("counts LLM verdicts that follow position instead of the page", () => {
    const items = key.raters.judge?.items ?? [];
    const tally = tallyPreference(key, [
      {
        rater: "judge",
        choices: items.map((item) => ({ itemId: item.itemId, picked: "left" })),
      },
    ]);
    expect(tally.llmJudge.judge?.flippedWithOrder).toBe(6);
  });

  it("rejects answers from an unknown rater or for an unknown item", () => {
    expect(() => tallyPreference(key, [{ rater: "eve", choices: [] }])).toThrow(
      /eve/u,
    );
    expect(() =>
      tallyPreference(key, [
        { rater: "ana", choices: [{ itemId: "nope", picked: "left" }] },
      ]),
    ).toThrow(/nope/u);
  });
});

describe("tallyLook", () => {
  it("takes the majority label per pair and scores the distance against it", () => {
    const first = { brief: "b", arm: "A", repeat: 1, image: "a.png" } as const;
    const second = { brief: "b", arm: "C", repeat: 1, image: "b.png" } as const;
    const third = { brief: "b", arm: "C", repeat: 2, image: "c.png" } as const;
    const pairs = [
      { id: "p1", first, second },
      { id: "p2", first, second: third },
    ];
    const items = raterSheet(pairs, { name: "ana", kind: "human" }, "s");
    const key: PairKey = {
      mode: "look",
      raters: { ana: { kind: "human", items } },
    };
    const distances = new Map([
      ["p1", 0.1],
      ["p2", 0.6],
    ]);
    const result = tallyLook(
      key,
      [
        {
          rater: "ana",
          choices: items.map((item) => ({
            itemId: item.itemId,
            picked: item.pairId === "p1" ? "same" : "different",
          })),
        },
      ],
      (pair) => distances.get(pair.id) as number,
    );
    expect(result).toMatchObject({ pairs: 2, auc: 1, validation: "light" });
  });
});
