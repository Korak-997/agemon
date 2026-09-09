import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
