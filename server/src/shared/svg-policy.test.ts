import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { sanitizeSvg } from '../agent/svg-sanitize.js';
const cases = JSON.parse(readFileSync(new URL('../../../e2e/fixtures/svg-policy-cases.json', import.meta.url), 'utf8')) as { name: string; source: string; allow: boolean }[];

describe('shared static SVG policy matrix', () => {
  it.each(cases)('$name', ({ source, allow }) => {
    if (!allow) { expect(() => sanitizeSvg(source)).toThrow(); return; }
    const clean = sanitizeSvg(source);
    expect(sanitizeSvg(clean)).toBe(clean);
    const parser = new DOMParser();
    const original = parser.parseFromString(source, 'image/svg+xml');
    for (const sheet of Array.from(original.getElementsByTagName('style'))) sheet.parentNode?.removeChild(sheet);
    expect(parser.parseFromString(clean, 'image/svg+xml').documentElement?.textContent).toBe(original.documentElement?.textContent);
  });

  it('resolves styles in the SVG cascade and keeps their internal marker references', () => {
    const source = '<svg><defs><marker id="a"><path d="M0 0L2 2"/></marker><style>'
      + '.label{fill:blue} text{fill:red} .label{fill:green;font-size:17px} .edge{marker-end:url(#a)}'
      + '</style></defs><text class="label" fill="yellow">标题</text>'
      + '<text class="label" style="fill:purple">节点</text><path class="edge" d="M0 0L10 10"/></svg>';
    const clean = sanitizeSvg(source);
    expect(clean).not.toContain('<style');
    expect(clean).toContain('fill="green" font-size="17px">标题');
    expect(clean).toContain('fill="purple" font-size="17px">节点');
    expect(clean).toContain('marker-end="url(#a)"');
    expect(sanitizeSvg(clean)).toBe(clean);
  });
});
