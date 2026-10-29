import { describe, expect, it } from 'vitest';
import { textEditBudgetBytes, textPageOffsets, withinTextEditBudget } from './text-budget.js';

describe('plain text and Markdown browser budget', () => {
  it('checks actual UTF-8 bytes and allows the exact limit', () => {
    expect(withinTextEditBudget('a'.repeat(textEditBudgetBytes))).toBe(true);
    expect(withinTextEditBudget('a'.repeat(textEditBudgetBytes + 1))).toBe(false);
    expect(withinTextEditBudget('中'.repeat(90_000))).toBe(false);
  });
  it('pages long text without losing CRLF, BOM, emoji or original syntax', () => {
    const value = '\uFEFF# heading\r\n' + '😀long `code` 中文\r\n'.repeat(2000);
    const offsets = textPageOffsets(value);
    const pages = offsets.slice(0, -1).map((start, index) => value.slice(start, offsets[index + 1]));
    expect(pages.join('')).toBe(value);
    expect(pages.every((page) => page.length <= 10_000)).toBe(true);
    expect(pages.every((page) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(page))).toBe(true);
    expect(textPageOffsets('')).toEqual([0]);
  });
});
