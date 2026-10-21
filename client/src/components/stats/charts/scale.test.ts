import { describe, expect, it } from 'vitest';
import { axisLabelIndexes, chartLayout, formatAxisTick, niceCeiling, valuesByDate } from './scale.js';

describe('chart scale', () => {
  it('rounds the axis ceiling up to a readable step', () => {
    expect(niceCeiling(0)).toBe(4);
    expect(niceCeiling(1)).toBe(4);
    expect(niceCeiling(10)).toBe(10);
    expect(niceCeiling(800, 4, 60)).toBe(1200);
    expect(niceCeiling(3)).toBe(4);
    expect(niceCeiling(6)).toBe(8);
    expect(niceCeiling(13)).toBe(20);
    expect(niceCeiling(100)).toBe(100);
  });

  it('keeps every day through 10 points and then every fifth plus the last', () => {
    expect(axisLabelIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(axisLabelIndexes(11)).toEqual([0, 5, 10]);
    expect(axisLabelIndexes(12)).toEqual([0, 5, 10, 11]);
    expect(axisLabelIndexes(30)).toEqual([0, 5, 10, 15, 20, 25, 29]);
  });

  it('widens short ranges and narrows a month so labels fit', () => {
    expect(chartLayout(7).slot).toBe(72);
    expect(chartLayout(9).slot).toBe(44);
    expect(chartLayout(30).slot).toBe(28);
    expect(chartLayout(30).height).toBe(168);
  });

  it('aligns rows onto the requested dates', () => {
    expect(valuesByDate(['2026-10-19', '2026-10-20', '2026-10-21'], [{ date: '2026-10-21', count: 4 }], (row) => row.count)).toEqual([0, 0, 4]);
    expect(formatAxisTick(2)).toBe('2');
    expect(formatAxisTick(2.5)).toBe('2.5');
  });
});
