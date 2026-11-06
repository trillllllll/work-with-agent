import { describe, expect, it } from 'vitest';
import { fixture, kinds } from './fixtures.js';
import { ExperimentalReplyParser, type ReplyParseEvent } from './parser.js';
import { closedElements, svgCandidate } from './markup.js';

describe('real JSON byte stream experiment', () => {
  for (const kind of kinds) for (const size of [1, 7, 32, 128]) it(`${kind.id}: ${size}-byte chunks preserve the result`, () => {
    const { wire, source } = fixture(kind.id);
    const bytes = new TextEncoder().encode(wire);
    const parser = new ExperimentalReplyParser(); const events: ReplyParseEvent[] = [];
    for (let i = 0; i < bytes.length; i += size) { parser.write(bytes.slice(i, i + size)); events.push(...parser.drain()); }
    parser.finish();
    const block = events.filter(event => event.kind === 'block').pop();
    expect(block?.kind).toBe('block');
    if (block?.kind === 'block') expect(block.value).toEqual(JSON.parse(wire).blocks[0]);
    const updates = events.filter(event => ['text', 'source', 'chart'].includes(event.kind));
    expect(updates.length).toBeGreaterThan(0);
    if (kind.id !== 'chart') {
      const last = updates[updates.length - 1];
      const value = last.kind === 'source' ? last.source : last.kind === 'text' ? last.text : '';
      expect(value).toBe(source);
      expect(JSON.stringify(updates)).not.toContain('�');
    } else {
      const chart = updates.filter(event => event.kind === 'chart');
      expect(chart[0].values.length).toBeGreaterThan(0);
      expect(chart[0].values).toEqual([3, 5, 4, 8, 6].slice(0, chart[0].values.length));
      expect(chart[chart.length - 1]).toMatchObject({ values: [3, 5, 4, 8, 6] });
    }
  });
  it('publishes partial text/source before closing a field and preserves escaped Unicode', () => {
    const parser = new ExperimentalReplyParser();
    parser.write('{"blocks":[{"type":"html","renderMode":"fragments","source":"<p>\\u4f60\\u597d ');
    expect(parser.drain()).toContainEqual({ kind: 'source', index: 0, blockType: 'html', renderMode: 'fragments', source: '<p>你好 ' });
    parser.write('\\ud83c');
    expect(JSON.stringify(parser.drain())).not.toContain('\\ud83c');
    parser.write('\\udf31</p>"}]}'); parser.finish();
    expect(parser.drain().filter(e => e.kind === 'source').pop()).toMatchObject({ source: '<p>你好 🌱</p>' });
  });
  it('replays a source field when type arrives later', () => {
    const parser = new ExperimentalReplyParser(); parser.write('{"blocks":[{"source":"<p>hello</p>","type":"html","renderMode":"fragments"}]}'); parser.finish();
    expect(parser.drain()).toContainEqual({ kind: 'source', index: 0, blockType: 'html', renderMode: 'fragments', source: '<p>hello</p>' });
  });
  it('keeps an interrupted reply incomplete', () => {
    const parser = new ExperimentalReplyParser(); parser.write('{"blocks":[{"type":"text","markdown":"已经收到');
    expect(parser.drain().some(e => e.kind === 'text')).toBe(true);
    expect(() => parser.finish()).toThrow();
  });
  it('rejects duplicate fields and a prototype property', () => {
    for (const body of ['{"type":"text","type":"svg"}', '{"__proto__":{}}']) {
      const parser = new ExperimentalReplyParser(); expect(() => parser.write('{"blocks":[' + body + ']}')).toThrow();
    }
  });
});

describe('conservative markup boundaries', () => {
  it('holds quoted > and unclosed parents', () => {
    expect(closedElements('<section data-a="a>b"><input value="hello"/>')).toEqual({ parts: [], rest: '<section data-a="a>b"><input value="hello"/>' });
    expect(closedElements('<p>one</p><section><p>two</p>')).toEqual({ parts: ['<p>one</p>'], rest: '<section><p>two</p>' });
  });
  it('buffers script and style bodies until the end tag', () => {
    expect(closedElements('<script>if(a<b){go()}').parts).toEqual([]);
    expect(closedElements('<script>if(a<b){go()}</script>').parts).toHaveLength(1);
    expect(closedElements('<style>p{color:red}').parts).toEqual([]);
  });
  it('keeps comments and only closes complete SVG children', () => {
    const source = '<svg viewBox="0 0 50 50"><!-- ok --><rect width="10"/><g><circle';
    expect(svgCandidate(source)).toBe('<svg viewBox="0 0 50 50"><!-- ok --><rect width="10"/></svg>');
    expect(svgCandidate('<svg viewBox="0')).toBe('');
  });
  it('rejects mismatched tags', () => { expect(() => closedElements('<g></p>')).toThrow(); });
});
