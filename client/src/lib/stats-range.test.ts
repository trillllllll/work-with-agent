import { describe, expect, it } from 'vitest';
import {
  addDays,
  chartState,
  compareDelta,
  eachDate,
  formatUsd,
  inclusiveDays,
  isSectionError,
  isSparse,
  isValidRange,
  presetRange,
  previousRange,
  resolveStatsRange,
  weekdayKey,
} from './stats-range.js';

describe('stats range', () => {
  const today = new Date(2026, 9, 21);

  it('builds inclusive presets that end today', () => {
    expect(presetRange(7, today)).toEqual({ from: '2026-10-15', to: '2026-10-21' });
    expect(presetRange(30, today)).toEqual({ from: '2026-09-22', to: '2026-10-21' });
    expect(inclusiveDays('2026-10-15', '2026-10-21')).toBe(7);
    expect(eachDate('2026-10-19', '2026-10-21')).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
  });

  it('rejects a reversed, impossible, or over-long range', () => {
    expect(isValidRange('2026-10-21', '2026-10-15')).toBe(false);
    expect(isValidRange('2026-02-29', '2026-03-01')).toBe(false);
    expect(inclusiveDays('2024-02-28', '2024-03-01')).toBe(3);
    expect(isValidRange('2025-01-01', '2026-01-02')).toBe(false);
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('reads the hash, defaulting to 7 days', () => {
    expect(resolveStatsRange({}, today)).toMatchObject({ mode: '7d', from: '2026-10-15', to: '2026-10-21', valid: true });
    expect(resolveStatsRange({ range: '30d' }, today).mode).toBe('30d');
    expect(resolveStatsRange({ range: 'custom', from: '2026-10-01', to: '2026-10-21' }, today)).toMatchObject({ mode: 'custom', valid: true });
    expect(resolveStatsRange({ range: 'custom', from: '2026-10-21', to: '2026-10-01' }, today).valid).toBe(false);
    expect(previousRange('2026-10-15', '2026-10-21')).toEqual({ from: '2026-10-08', to: '2026-10-14' });
  });

  it('names weekdays from the calendar date', () => {
    expect(weekdayKey('2026-10-20')).toBe('tue');
  });

  it('compares a window with the previous one', () => {
    expect(compareDelta(10, 0)).toEqual({ direction: 'none', percent: 0 });
    expect(compareDelta(10, null)).toEqual({ direction: 'none', percent: 0 });
    expect(compareDelta(15, 10)).toEqual({ direction: 'up', percent: 50 });
    expect(compareDelta(5, 10)).toEqual({ direction: 'down', percent: 50 });
    expect(compareDelta(10, 10)).toEqual({ direction: 'flat', percent: 0 });
    expect(compareDelta(10.04, 10).direction).toBe('flat');
  });

  it('hides a trend until there are enough active days', () => {
    expect(isSparse([1, 0, 0, 0])).toBe(true);
    expect(isSparse([1, 1, 0, 0, 0])).toBe(true);
    expect(isSparse([1, 1, 1, 0, 0])).toBe(true);
    expect(isSparse([1, 1, 3, 0, 0])).toBe(false);
    expect(isSparse([2, 2, 2])).toBe(false);
    expect(chartState([0, 0, 0, 0, 0])).toBe('empty');
    expect(chartState([1, 0, 0, 0, 0])).toBe('sparse');
    expect(chartState([1, 1, 3, 0, 0])).toBe('ready');
  });

  it('formats cost and recognizes a section error', () => {
    expect(formatUsd(5_130_000)).toBe('$5.13');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(5_000)).toBe('$0.0050');
    expect(isSectionError({ error: { code: 'X', message: 'nope' } })).toBe(true);
    expect(isSectionError({ completed: 1 })).toBe(false);
  });
});
