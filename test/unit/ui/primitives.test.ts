import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  renderUnifiedDiff,
  styleUnifiedDiff,
} from "../../../src/core/text-diff.js";
import {
  badge,
  bullet,
  countLine,
  kv,
  rule,
  section,
  terminalWidth,
} from "../../../src/ui/format.js";
import { symbol } from "../../../src/ui/symbols.js";
import { renderTable } from "../../../src/ui/table.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

let originalColumns: number | undefined;

beforeAll(() => {
  process.env.NO_COLOR = "1";
  originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: 80,
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(process.stdout, "columns", {
    value: originalColumns,
    configurable: true,
  });
});

describe("format primitives (NO_COLOR)", () => {
  it("clamps terminal width into [60, 100]", () => {
    expect(terminalWidth()).toBe(80);
  });

  it("renders a section as a blank line and a heading", () => {
    expect(section("Resources")).toBe(`\nResources`);
  });

  it("draws a rule at the requested width", () => {
    expect(rule(10)).toBe("──────────");
  });

  it("aligns key/value pairs on the widest key", () => {
    expect(
      kv([
        ["id", "abc"],
        ["capability", "master-prompt"],
      ]),
    ).toBe("id          abc\ncapability  master-prompt");
  });

  it("renders bullets and plain badges without ANSI", () => {
    expect(bullet("do the thing")).toBe("· do the thing");
    expect(bullet("nested", 1)).toBe("  · nested");
    expect(badge("drifted", "warn")).toBe("[ drifted ]");
    expect(ANSI.test(badge("ok", "ok"))).toBe(false);
  });

  it("joins count parts with a dim separator", () => {
    expect(
      countLine([
        { n: 3, label: "create" },
        { n: 1, label: "conflict" },
      ]),
    ).toBe("3 create · 1 conflict");
  });
});

describe("symbols", () => {
  it("falls back to the ASCII map when NO_COLOR is set", () => {
    expect(symbol("ok")).toBe("[ok]");
    expect(symbol("fail")).toBe("[x]");
    expect(symbol("arrow")).toBe("->");
    expect(symbol("conflict")).toBe("!");
  });
});

describe("renderTable (NO_COLOR)", () => {
  it("prints a header row, an underline rule and a two-space left gutter", () => {
    const lines = renderTable([
      ["RESOURCE", "STATE"],
      ["AGENTS.md", "managed"],
      ["CLAUDE.md", "adopted"],
    ]).split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("  RESOURCE   STATE");
    expect(lines[1].trim()).toMatch(/^─+(\s+─+)*$/);
    expect(lines.every((line) => line.startsWith("  "))).toBe(true);
    expect(lines[2]).toContain("AGENTS.md");
  });

  it("right-aligns a column whose data cells are all numeric", () => {
    const dataRow = renderTable([
      ["FILE", "REDACTED"],
      ["settings.json", "2"],
      ["mcp.json", "10"],
    ]).split("\n")[2];

    expect(dataRow).toMatch(/\s2$/);
  });

  it("aligns columns whose cells contain wide CJK characters", () => {
    const lines = renderTable([
      ["FILE", "STATUS"],
      ["表.md", "ok"],
      ["b.md", "critical"],
    ]).split("\n");

    expect(lines[0]).toBe("  FILE   STATUS");
    expect(lines[2]).toBe("  表.md  ok");
    expect(lines[3]).toBe("  b.md   critical");
  });

  it("truncates emoji cells without emitting an unpaired surrogate", () => {
    const dataLine = renderTable([
      ["FILE", "STATUS"],
      ["x", "😀".repeat(45)],
    ]).split("\n")[2];

    expect(dataLine).toContain("…");
    expect(dataLine).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe("renderTable (colored output)", () => {
  const stripAnsi = (value: string) => value.replace(new RegExp(ANSI, "g"), "");
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeAll(() => {
    originalNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterAll(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  });

  it("aligns columns by visible width when cells carry ANSI-styled badges", () => {
    const lines = renderTable([
      ["RESOURCE", "STATE"],
      ["a.md", badge("ok", "ok")],
      ["b.md", "critical-issue-needs-attention"],
    ])
      .split("\n")
      .map(stripAnsi);

    const columnOneWidth = "RESOURCE".length;
    const secondColumnStart = "  ".length + columnOneWidth + "  ".length;

    expect(lines[2].slice(secondColumnStart).trim()).toBe("ok");
    expect(lines[3].slice(secondColumnStart).trim()).toBe(
      "critical-issue-needs-attention",
    );
  });

  it("truncates ANSI-styled cells without corrupting escape codes", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 40,
      configurable: true,
    });

    const dataLine = renderTable([
      ["FILE", "STATUS"],
      [
        "x",
        badge("an unusually long status label that must be truncated", "warn"),
      ],
    ]).split("\n")[2];

    expect(stripAnsi(dataLine)).toContain("…");
    expect(dataLine.endsWith(`${String.fromCharCode(27)}[0m`)).toBe(true);
  });
});

describe("styleUnifiedDiff", () => {
  it("returns the raw diff untouched when no options are passed", () => {
    const raw = renderUnifiedDiff("a\nb\n", "a\nc\n", "f.txt");
    expect(raw).toBe("--- f.txt\n+++ f.txt\n a\n-b\n+c");
  });

  it("collapses long unchanged runs down to the context window", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = `${before}\nnew tail`;
    const styled = styleUnifiedDiff(
      renderUnifiedDiff(before, after, "big.txt"),
      { context: 2 },
    );

    expect(styled).toContain("⋯ 16 unchanged lines");
    expect(styled).toContain("+new tail");
  });

  it("trims the diff when it exceeds maxLines", () => {
    const before = "";
    const after = Array.from({ length: 10 }, (_, i) => `add ${i}`).join("\n");
    const styled = styleUnifiedDiff(renderUnifiedDiff(before, after, "f"), {
      maxLines: 4,
    });

    expect(styled).toContain("⋯ diff trimmed, 6 more lines");
  });
});
