import { describe, expect, it } from 'vitest';
import { measureRichDocument, richDocumentBlockPage, richDocumentEditBudget, richDocumentTextPage } from './RichDocumentBoundary.js';
import type { LocalRichBlock, LocalRichDocument } from './richdoc-codec.js';
const paragraph = (id: string, text: string): LocalRichBlock => ({ id, kind: 'paragraph', text: [{ text }] });

describe('rich document browser editing budget', () => {
  it('matches JSON UTF-8 sizes for allowed content, including escapes and surrogate pairs', () => {
    const value: LocalRichDocument = { schemaVersion: 1, blocks: [paragraph('one', '中文😀\n\t"\\\u0001\ud800')] };
    const measured = measureRichDocument(value);
    expect(measured).toEqual({ blocks: 1, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength, withinBudget: true });
  });

  it('rejects the block after the budget and an oversized single paragraph without changing either document', () => {
    const limit = richDocumentEditBudget.blocks;
    const value: LocalRichDocument = { schemaVersion: 1, blocks: Array.from({ length: limit + 1 }, (_, index) => paragraph(String(index), 'small')) };
    expect(measureRichDocument({ ...value, blocks: value.blocks.slice(0, limit) }).withinBudget).toBe(true);
    expect(measureRichDocument(value).withinBudget).toBe(false);
    expect(value.blocks).toHaveLength(limit + 1);
    const text = 'a'.repeat(richDocumentEditBudget.bytes + 1);
    expect(measureRichDocument({ schemaVersion: 1, blocks: [paragraph('long', text)] }).withinBudget).toBe(false);
    expect(text.length).toBe(richDocumentEditBudget.bytes + 1);
  });

  it('counts deeply nested structures iteratively and preserves all characters across text pages', () => {
    let block: LocalRichBlock = paragraph('leaf', 'text');
    for (let index = 0; index < richDocumentEditBudget.blocks; index++) block = { id: `quote-${index}`, kind: 'blockquote', children: [block] };
    expect(measureRichDocument({ schemaVersion: 1, blocks: [block] }).withinBudget).toBe(false);
    const content = '😀'.repeat(12_000);
    const blocks = [paragraph('emoji', content)];
    const first = richDocumentTextPage(blocks, 0); const second = richDocumentTextPage(blocks, 1);
    expect(Array.from(first.text)).toHaveLength(10_000);
    expect(first.hasNext).toBe(true); expect(second.hasNext).toBe(false);
    expect(first.text + second.text).toBe(`${content}\n`);
    expect(blocks[0]).toEqual(paragraph('emoji', content));
  });

  it('locates the page containing a nested stable block without changing its identity', () => {
    const blocks = Array.from({ length: 201 }, (_, index) => paragraph(String(index), 'text'));
    blocks[150] = { id: 'list', kind: 'bulletList', children: [{ id: 'item', kind: 'listItem', children: [paragraph('target', 'heading')] }] };
    expect(richDocumentBlockPage(blocks, 'target')).toBe(1);
    expect(richDocumentBlockPage(blocks, '200')).toBe(2);
    expect(richDocumentBlockPage(blocks, 'missing')).toBeNull();
  });
});
