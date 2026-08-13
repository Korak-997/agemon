export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  const columnCount = rows[0].length;
  const columnWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );

  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(columnWidths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
