import { terminalWidth } from "./format.js";
import { theme } from "./theme.js";

const LEFT_GUTTER = "  ";
const COLUMN_GAP = "  ";
const ELLIPSIS = "…";
const MIN_COLUMN_WIDTH = 3;

function isNumericCell(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return ELLIPSIS;
  return `${value.slice(0, width - 1)}${ELLIPSIS}`;
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
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
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
      const padded = rightAligned[column]
        ? clipped.padStart(columnWidths[column])
        : clipped.padEnd(columnWidths[column]);
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
