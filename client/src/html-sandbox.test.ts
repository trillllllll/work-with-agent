import { describe, it, expect } from 'vitest';
import { buildCsp, buildSrcdoc, clampHeight, mergeFill, readBridgeMessage, safeCdn } from './lib/html-sandbox.js';

describe('html sandbox document', () => {
  it('puts the CSP before any model markup and blocks every network path except the allowlist', () => {
    const doc = buildSrcdoc('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>hi</p>', { cdn: ['https://cdn.jsdelivr.net'], theme: 'dark' });
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf('default-src *'));
    const csp = buildCsp(['https://cdn.jsdelivr.net']);
    for (const part of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "worker-src 'none'"]) expect(csp).toContain(part);
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).not.toContain('unsafe-eval');
    expect(doc).toContain('wwa:fill-input');
    expect(buildSrcdoc('<p>x</p>', { cdn: [], theme: 'light', bridge: false })).not.toContain('wwa:fill-input');
  });
  it('drops allowlist entries that could widen the CSP', () => {
    expect(safeCdn(['https://cdn.jsdelivr.net', "https://a.example 'unsafe-eval'", '*', 'https://x.example; connect-src *', 'http://evil.example'])).toEqual(['https://cdn.jsdelivr.net']);
  });
  it('accepts only exact bridge messages and rejects oversized fills instead of truncating', () => {
    expect(readBridgeMessage({ type: 'wwa:fill-input', text: ' 选 A\u202e ' })).toEqual({ type: 'fill', text: '选 A' });
    expect(readBridgeMessage({ type: 'wwa:resize', height: 400 })).toEqual({ type: 'resize', height: 400 });
    expect(readBridgeMessage({ type: 'wwa:fill-input', text: 'x'.repeat(2001) })).toMatchObject({ type: 'invalid' });
    for (const data of [null, 'wwa:fill-input', { type: 'wwa:fill-input', text: 'x', send: true }, { type: 'wwa:send', text: 'x' }, { type: 'wwa:resize', height: Infinity }, Object.assign(Object.create({ evil: 1 }), { type: 'wwa:resize', height: 1 })])
      expect(readBridgeMessage(data)).toSatisfy((value: unknown) => value === null || (value as { type: string }).type === 'invalid');
    expect(clampHeight(5, undefined)).toBe(120); expect(clampHeight(99999, undefined)).toBe(1200); expect(clampHeight(900, 600)).toBe(600);
  });
  it('fills an empty composer, replaces its own previous choice, and never overwrites what the user typed', () => {
    expect(mergeFill('', '选 A', null)).toBe('选 A');
    expect(mergeFill('选 A', '选 B', '选 A')).toBe('选 B');
    expect(mergeFill('我的想法', '选 B', null)).toBe('我的想法\n选 B');
    expect(mergeFill('我的想法\n选 A', '选 B', '选 A')).toBe('我的想法\n选 B');
  });
});
