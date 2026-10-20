import { describe, expect, it } from 'vitest';
import { customRange, weekRange } from './week-range.js';

describe('weekRange', () => {
  it('starts at local Monday 00:00 and ends the next Monday', () => {
    const now = new Date(2026, 9, 21, 15, 30, 45);
    const { from, to } = weekRange(now, 0);
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(9);
    expect(from.getDate()).toBe(19);
    expect(from.getDay()).toBe(1);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getSeconds()).toBe(0);
    expect(to.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(to.getDay()).toBe(1);
    expect(to.getDate()).toBe(26);
  });

  it('keeps Sunday inside the week that started the previous Monday', () => {
    const { from, to } = weekRange(new Date(2026, 9, 25, 23, 0, 0), 0);
    expect(from.getDate()).toBe(19);
    expect(to.getDate()).toBe(26);
  });

  it('shifts by whole weeks', () => {
    const now = new Date(2026, 9, 21, 12, 0, 0);
    const current = weekRange(now, 0);
    const last = weekRange(now, -1);
    expect(last.to.getTime()).toBe(current.from.getTime());
    expect(last.from.getDate()).toBe(12);
    expect(last.from.getDay()).toBe(1);
  });

  it('treats custom dates as inclusive local days', () => {
    const range = customRange('2026-10-19', '2026-10-25');
    expect(range).not.toBeNull();
    expect(range!.from.getDate()).toBe(19);
    expect(range!.from.getHours()).toBe(0);
    expect(range!.to.getDate()).toBe(26);
    expect(range!.to.getHours()).toBe(0);
    expect(customRange('2026-10-21', '2026-10-19')).toBeNull();
  });
});
