import { describe, expect, it } from 'vitest';
import { compactTokens, shownContextUsage, usageLevel, windowPercent, type ContextUsage } from './context-usage.js';

const stats = (estimatedInputTokens: number, contextWindow: number | null, kind: 'run' | 'preview' = 'run') => ({ estimatedInputTokens, contextWindow, kind }) as ContextUsage;

describe('context ring calculations', () => {
  it('never invents a percentage without a positive model window', () => {
    expect(windowPercent(stats(1200, null))).toBeNull();
    expect(windowPercent(stats(1200, 0))).toBeNull();
    expect(compactTokens(1200)).toBe('1.2k');
  });

  it('keeps real zero, middle, full, and overflow values truthful', () => {
    expect(windowPercent(stats(0, 100))).toBe(0);
    expect(windowPercent(stats(50, 100))).toBe(50);
    expect(windowPercent(stats(100, 100))).toBe(100);
    expect(windowPercent(stats(120, 100))).toBe(120);
    expect(usageLevel(0)).toBe('normal');
    expect(usageLevel(80)).toBe('high');
    expect(usageLevel(120)).toBe('full');
  });

  it('shows the live attempt while busy, the next preview while idle, and retains the latest stats', () => {
    const run = stats(20, 100);
    const preview = stats(30, 100, 'preview');
    expect(shownContextUsage(run, preview, true)).toBe(run);
    expect(shownContextUsage(run, preview, false)).toBe(preview);
    expect(shownContextUsage(run, null, true)).toBe(run);
    expect(shownContextUsage(null, preview, true)).toBe(preview);
  });
});
