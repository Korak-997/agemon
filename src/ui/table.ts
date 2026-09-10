import stringWidth from "string-width";
import { terminalWidth } from "./format.js";
import { theme } from "./theme.js";

const LEFT_GUTTER = "  ";
const COLUMN_GAP = "  ";
const ELLIPSIS = "…";
const MIN_COLUMN_WIDTH = 3;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_AT_START = new RegExp(`^${ESCAPE_CHARACTER}\\[[0-9;]*m`);
const ANSI_RESET = `${ESCAPE_CHARACTER}[0m`;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function visibleWidth(value: string): number {
  return stringWidth(value);
}

function isNumericCell(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

function padCell(value: string, width: number, align: "start" | "end"): string {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(value)));
  return align === "start" ? padding + value : value + padding;
}

function truncateCell(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return ELLIPSIS;

  const targetVisibleWidth = width - 1;
  let renderedWidth = 0;
  let cursor = 0;
  let truncated = "";
  let sawEscapeCode = false;

  while (cursor < value.length) {
    const escapeMatch = ANSI_ESCAPE_AT_START.exec(value.slice(cursor));
    if (escapeMatch) {
      truncated += escapeMatch[0];
      cursor += escapeMatch[0].length;
      sawEscapeCode = true;
      continue;
    }

    const remainder = value.slice(cursor);
    const nextGrapheme = GRAPHEME_SEGMENTER.segment(remainder)
      [Symbol.iterator]()
      .next();
    if (nextGrapheme.done) break;

    const grapheme = nextGrapheme.value.segment;
    const graphemeWidth = stringWidth(grapheme);
    if (renderedWidth + graphemeWidth > targetVisibleWidth) break;

    truncated += grapheme;
    renderedWidth += graphemeWidth;
    cursor += grapheme.length;
  }

  return sawEscapeCode
    ? `${truncated}${ELLIPSIS}${ANSI_RESET}`
    : `${truncated}${ELLIPSIS}`;
}

function fitColumnWidths(naturalWidths: number[], available: number): number[] {
  const widths = [...naturalWidths];
  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN_COLUMN_WIDTH) break;
    widths[widest] -= 1;
    total -= 1;
  }
  return widths;
}

export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  const [header, ...body] = rows;
  const columnCount = header.length;

  const naturalWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => visibleWidth(row[column] ?? ""))),
  );
  const available =
    terminalWidth() -
    LEFT_GUTTER.length -
    COLUMN_GAP.length * (columnCount - 1);
  const columnWidths = fitColumnWidths(naturalWidths, available);

  const rightAligned = Array.from(
    { length: columnCount },
    (_, column) =>
      body.length > 0 && body.every((row) => isNumericCell(row[column] ?? "")),
  );

  const renderRow = (
    row: string[],
    paint: (cell: string) => string,
  ): string => {
    const cells = row.map((cell, column) => {
      const clipped = truncateCell(cell ?? "", columnWidths[column]);
      const padded = padCell(
        clipped,
        columnWidths[column],
        rightAligned[column] ? "start" : "end",
      );
      return paint(padded);
    });
    return (LEFT_GUTTER + cells.join(COLUMN_GAP)).replace(/\s+$/, "");
  };

  const headerRule = columnWidths
    .map((width) => "─".repeat(width))
    .join(COLUMN_GAP);

  return [
    renderRow(header, (cell) => theme.dim(cell)),
    (LEFT_GUTTER + theme.dim(headerRule)).replace(/\s+$/, ""),
    ...body.map((row) => renderRow(row, (cell) => cell)),
  ].join("\n");
}
