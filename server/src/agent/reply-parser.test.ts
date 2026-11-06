import { describe, it, expect } from 'vitest';
import { ReplyParser, type ReplyParseEvent } from './reply-parser.js';
const fixture = '{"blocks":[{"type":"text","markdown":"中文😀 \\uD83D\\uDE00 \\u4e2d \\\"{}[]\\\" \\\\"},{"source":"flowchart LR\\nA-->B","type":"mermaid"},{"markdown":"结束","type":"text"}]}';
function parse(chunks: Array<string | Uint8Array>) {
  const parser = new ReplyParser(); const events: ReplyParseEvent[] = [];
  for (const chunk of chunks) { parser.write(chunk); events.push(...parser.drain()); }
  parser.finish(); return events;
}
const blocks = (events: ReplyParseEvent[]) => events.filter((event) => event.kind === 'block');
describe('incremental structured reply', () => {
  it('commits identically at every character, UTF-16 surrogate and UTF-8 byte boundary', () => {
    const expected = blocks(parse([fixture]));
    for (let i = 0; i <= fixture.length; i++) expect(blocks(parse([fixture.slice(0, i), fixture.slice(i)]))).toEqual(expected);
    const bytes = Buffer.from(fixture);
    for (let i = 0; i <= bytes.length; i++) expect(blocks(parse([bytes.subarray(0, i), bytes.subarray(i)]))).toEqual(expected);
    expect(blocks(parse(fixture.split('')))).toEqual(expected);
  });
  it('shows decoded text before its closing quote and Mermaid before the root ends', () => {
    const parser = new ReplyParser();
    parser.write('{"blocks":[{"type":"text","markdown":"你好');
    expect(parser.drain()).toContainEqual({ kind: 'text', index: 0, text: '你好' });
    parser.write('"},{"type":"mermaid","source":"flowchart LR; A-->B"},{"type":"text","markdown":"后续');
    const events = parser.drain();
    expect(events.some((event) => event.kind === 'block' && event.index === 1)).toBe(true);
    expect(events).toContainEqual({ kind: 'text', index: 2, text: '后续' });
    expect(() => parser.finish()).toThrow();
  });
  it('handles fields before type and does not publish undecided text', () => {
    const parser = new ReplyParser();
    parser.write('{"blocks":[{"markdown":"先文本');
    expect(parser.drain().some((event) => event.kind === 'text')).toBe(false);
    parser.write('","type":"text"}]}');
    expect(parser.drain()).toContainEqual({ kind: 'text', index: 0, text: '先文本' });
    parser.finish();
  });
  it('rejects duplicate fields, trailing commas, multiple roots, nonfinite numbers and limits', () => {
    for (const input of ['{"blocks":[],"blocks":[]}', '{"blocks":[{"type":"text","type":"svg"}]}', '{"blocks":[{}],}', '{"blocks":[{},]}', '{"blocks":[{}]}{}', '{"blocks":[{"x":1e999}]}', '{"blocks":[1]}']) expect(() => parse([input])).toThrow();
    expect(() => parse(['{"blocks":[{"markdown":"' + 'a'.repeat(65537)])).toThrow();
    expect(() => parse(['{"blocks":[' + Array(33).fill('{}').join(',') + ']}'])).toThrow();
  });
  it('never publishes a partial Unicode escape or a raw half surrogate', () => {
    const parser = new ReplyParser();
    parser.write('{"blocks":[{"type":"text","markdown":"\\uD83D');
    expect(parser.drain().filter((event) => event.kind === 'text').every((event) => !/[\uD800-\uDBFF]$/.test(event.text))).toBe(true);
    parser.write('\\uDE00"}]}');
    expect(parser.drain()).toContainEqual({ kind: 'text', index: 0, text: '😀' }); parser.finish();
  });
});

describe('progressive sources and complete chart items', () => {
  it('streams all graphic types at single UTF-8 byte boundaries and replays late metadata', () => {
    for (const type of ['svg', 'mermaid', 'html']) for (const late of [false, true]) {
      const source = '<p>中文😀 " \\</p>\n';
      const metadata = { type, ...(type === 'html' ? { renderMode: 'fragments' } : {}) };
      const block = late ? { source, ...metadata } : { ...metadata, source };
      const bytes = Buffer.from(JSON.stringify({ blocks: [block] }));
      const events = parse([...bytes].map(byte => Uint8Array.of(byte)));
      const updates = events.filter(event => event.kind === 'source');
      expect(updates.at(-1)).toMatchObject({ source, blockType: type });
      expect(updates.every(event => !/[\uD800-\uDBFF]$/.test(event.source))).toBe(true);
    }
  });
  it('does not stream legacy full HTML documents', () => {
    expect(parse(['{"blocks":[{"type":"html","source":"<p>complete</p>"}]}']).some(event => event.kind === 'source')).toBe(false);
  });
  it.each(['pie', 'scatter'])('holds the unfinished %s item until its closing delimiter', (kind) => {
    const parser = new ReplyParser();
    parser.write(kind === 'pie' ? '{"blocks":[{"type":"chart","spec":{"kind":"pie","values":[{"name":"A","value":12 ' : '{"blocks":[{"type":"chart","spec":{"kind":"scatter","series":[{"name":"A","values":[[1,2 ');
    expect(parser.drain().some(event => event.kind === 'chart')).toBe(false);
    parser.write(kind === 'pie' ? '}' : ']');
    expect(parser.drain().find(event => event.kind === 'chart')).toMatchObject({ spec: { kind, provenance: { kind: 'unverified' } } });
  });
  it.each(['bar', 'line', 'pie', 'scatter'])('preserves %s multi-series data, reordered fields and never verifies previews', kind => {
    const spec = { title: '数据', provenance: { kind: 'tool', label: '待核验' }, ...(kind === 'pie' ? { values: [{ value: 3, name: 'A' }, { name: 'B', value: 5 }] } : { series: [{ values: kind === 'scatter' ? [[1, 2], [3, 4]] : [1, 2], name: '一' }, { name: '二', values: kind === 'scatter' ? [[5, 6]] : [3, 4] }], ...(kind === 'scatter' ? {} : { categories: ['A', 'B'] }) }), kind };
    const wire = JSON.stringify({ blocks: [{ spec, type: 'chart' }] });
    const events = parse(wire.split(''));
    const preview = events.filter(event => event.kind === 'chart').at(-1);
    expect(preview).toMatchObject({ spec: { ...spec, provenance: { kind: 'unverified', label: '待核验' } } });
  });
});

it('does not preview a completed but invalid pie item with unknown fields', () => {
  const events = parse(['{"blocks":[{"type":"chart","spec":{"kind":"pie","values":[{"name":"A","value":1,"unexpected":true}]}}]}']);
  expect(events.some(event => event.kind === 'chart')).toBe(false);
});
