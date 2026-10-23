import { describe, expect, it } from 'vitest';
import { fitInlineTags, inlineSchedule, tagInitial } from './task-inline.js';

describe('inline task presentation', () => {
  it('keeps graphemes intact, including combined emoji and accented letters', () => {
    expect(['青鸟', 'AI提效', ' 👩🏽‍💻开发', 'e\u0301lan', '🇨🇳工作', ''].map(tagInitial)).toEqual(['青', 'A', '👩🏽‍💻', 'e\u0301', '🇨🇳', '']);
  });
  it('yields tags before the title, aggregates excess, and restores full labels on expansion', () => {
    const fit = (width: number) => fitInlineTags(width, 120, 30, [70, 70, 70], [21, 21, 21], () => 25);
    expect(fit(500)).toEqual({ short: false, visible: 3 });
    expect(fit(250)).toEqual({ short: true, visible: 3 });
    expect(fit(160)).toEqual({ short: true, visible: 1 });
    expect(fit(90)).toEqual({ short: true, visible: 0 });
    expect(fit(500)).toEqual({ short: false, visible: 3 });
    expect(fitInlineTags(100, 300, 0, [], [], () => 0)).toEqual({ short: false, visible: 0 });
  });
  it('preserves local dates and cross-day intent without parsing as UTC', () => {
    const base = { dueDate: null, scheduledStart: '2026-12-31T23:30', scheduledEnd: '2027-01-01T01:00' };
    expect(inlineSchedule(base, '2026-12-31')?.label).toBe('23:30 ↗');
    expect(inlineSchedule(base, '2026-10-24')?.label).toBe('12/31 23:30 ↗');
    expect(inlineSchedule({ ...base, scheduledEnd: null }, '2026-10-24')?.dateTime).toBe(base.scheduledStart);
    expect(inlineSchedule({ dueDate: '2028-02-29', scheduledStart: null, scheduledEnd: null }, '2026-10-24')?.label).toBe('2/29');
    expect(inlineSchedule({ dueDate: null, scheduledStart: null, scheduledEnd: null }, '2026-10-24')).toBeNull();
  });
});
