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
    expect(parser.parseFromString(clean, 'image/svg+xml').documentElement?.textContent).toBe(parser.parseFromString(source, 'image/svg+xml').documentElement?.textContent);
  });
});
