export type PdfOutlineNode = { title: string; dest: string | unknown[] | null; items?: PdfOutlineNode[] };
export type PdfOutlineEntry = Omit<PdfOutlineNode, 'items'> & { depth: number };

/** Bound siblings as well as nesting; a flat outline can be much larger than a deep one. */
export function boundedPdfOutline(nodes: PdfOutlineNode[], maxEntries = 1000, maxDepth = 20) {
  const entries: PdfOutlineEntry[] = [];
  let truncated = false;
  const visit = (items: PdfOutlineNode[], depth: number) => {
    for (const node of items) {
      if (depth > maxDepth || entries.length >= maxEntries) { truncated = true; return; }
      entries.push({ title: node.title, dest: node.dest, depth });
      if (node.items?.length) visit(node.items, depth + 1);
    }
  };
  visit(nodes, 0);
  return { entries, truncated };
}

export type CellPosition = { row: number; col: number };
export function parseWorkbookRange(value: string): { start: CellPosition; end: CellPosition } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/i.exec(value.trim());
  if (!match) return null;
  const position = (letters: string, row: string): CellPosition => ({ row: Number(row), col: [...letters.toUpperCase()].reduce((column, letter) => column * 26 + letter.charCodeAt(0) - 64, 0) });
  const start = position(match[1], match[2]);
  const end = match[3] ? position(match[3], match[4]) : start;
  if ([start, end].some((cell) => cell.row > 1_048_576 || cell.col > 16_384) || end.row < start.row || end.col < start.col) return null;
  return { start, end };
}
