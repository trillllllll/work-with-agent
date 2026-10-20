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
