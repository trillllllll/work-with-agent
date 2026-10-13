import { describe, expect, it } from 'vitest';
import { formatLocator } from './types.js';

describe('formatLocator', () => {
  it('returns an empty place when the extraction error has no locator', () => {
    expect(formatLocator(null)).toBe('');
    expect(formatLocator(undefined)).toBe('');
  });

  it('still names a line range when the locator is present', () => {
    expect(formatLocator({ kind: 'line', startLine: 2, endLine: 4, start: 0, end: 0 })).toBe('第 2–4 行');
  });
});
