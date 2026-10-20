import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { formatCost, formatDiff, formatDuration, formatTokens, jobDurationMs, readJobChecks } from './format.js';

describe('orchestration format helpers', () => {
  beforeEach(async () => { await setLanguage('zh-CN'); });

  it('builds durations from locale units', async () => {
    expect(formatDuration(62_000)).toBe('1分2秒');
    expect(formatDuration(3_662_000)).toBe('1小时1分2秒');
    expect(formatDuration(3_600_000)).toBe('1小时');
    expect(formatDuration(0)).toBe('0秒');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    await setLanguage('en');
    expect(formatDuration(62_000)).toBe('1m2s');
    expect(formatDuration(3_662_000)).toBe('1h1m2s');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats tokens, cost, and diff', async () => {
    expect(formatTokens(1200)).toBe('1200');
    expect(formatTokens(null)).toBe('—');
    expect(formatCost(1_500_000)).toBe('$1.5000');
    expect(formatCost(null)).toBe('—');
    expect(formatDiff(4, 9, 1)).toBe('+9 −1 · 4 个文件');
    expect(formatDiff(null, null, null)).toBe('—');
    await setLanguage('en');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatDiff(4, 9, 1)).toBe('+9 −1 · 4 files');
  });

  it('reads job duration and nested checks', () => {
    expect(jobDurationMs('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z')).toBe(1000);
    expect(jobDurationMs('2026-10-01T00:00:02.000Z', '2026-10-01T00:00:01.000Z')).toBeNull();
    expect(jobDurationMs(null, '2026-10-01T00:00:01.000Z')).toBeNull();
    expect(readJobChecks({ result: { ok: true, result: { result: { checks: [{ name: 'unit', passed: true }, { name: 1, passed: false }] } } } })).toEqual([{ name: 'unit', passed: true }]);
    expect(readJobChecks({})).toEqual([]);
  });
});
