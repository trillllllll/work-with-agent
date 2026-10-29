import { describe, expect, it } from 'vitest';
import { boundedPdfOutline, parseWorkbookRange, type PdfOutlineNode } from './navigation.js';

describe('reader navigation bounds', () => {
  it('stops a flat PDF outline at its budget without reading later titles or destinations', () => {
    const nodes: PdfOutlineNode[] = Array.from({ length: 1000 }, (_, index) => ({ title: `Section ${index}`, dest: [index] }));
    nodes.push({ get title(): string { throw new Error('outline budget was exceeded'); }, dest: null });
    const result = boundedPdfOutline(nodes);
    expect(result.entries).toHaveLength(1000);
    expect(result.entries[999]).toEqual({ title: 'Section 999', dest: [999], depth: 0 });
    expect(result.truncated).toBe(true);
  });

  it('limits nested outlines while retaining later siblings and exact-boundary outlines', () => {
    const nested: PdfOutlineNode = { title: 'deep', dest: null };
    let child = nested;
    for (let depth = 0; depth < 30; depth++) { const next = { title: `child-${depth}`, dest: null }; child.items = [next]; child = next; }
    const result = boundedPdfOutline([nested, { title: 'last sibling', dest: 'last' }]);
    expect(Math.max(...result.entries.map((entry) => entry.depth))).toBe(20);
    expect(result.entries[result.entries.length - 1]?.title).toBe('last sibling');
    expect(result.truncated).toBe(true);
    expect(boundedPdfOutline([{ title: 'only', dest: null }], 1).truncated).toBe(false);
  });

  it('parses real Excel boundaries without allocating cells in a workbook', () => {
    expect(parseWorkbookRange(' b120:c150 ')).toEqual({ start: { row: 120, col: 2 }, end: { row: 150, col: 3 } });
    expect(parseWorkbookRange('XFD1048576')).toEqual({ start: { row: 1_048_576, col: 16_384 }, end: { row: 1_048_576, col: 16_384 } });
    for (const value of ['ZZZ1', 'XFE1', 'A1048577', 'A9999999', 'A0', 'A01', 'A1:XFE5', 'A1:A1048577', 'B2:A1', 'A1:B', 'A1:B2:C3']) expect(parseWorkbookRange(value), value).toBeNull();
  });
});
