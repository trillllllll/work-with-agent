import { describe, expect, it } from 'vitest';
import { emptySchedule, normalizeLegacySchedule, normalizeSchedule, scheduleLastDate } from './schedule.js';

describe('unified task schedule', () => {
  const range = { dueDate: '2026-10-11', scheduledStart: '2026-10-11T23:00', scheduledEnd: '2026-10-12T01:00' };
  it('supports all four states and atomic conversions', () => {
    const allDay = normalizeSchedule(emptySchedule, { dueDate: '2026-10-11' });
    const point = normalizeSchedule(allDay, { scheduledStart: '2026-10-11T15:00' });
    expect(point).toEqual({ ...allDay, scheduledStart: '2026-10-11T15:00' });
    expect(normalizeSchedule(point, { scheduledEnd: '2026-10-11T16:00' })).toEqual({ ...point, scheduledEnd: '2026-10-11T16:00' });
    expect(normalizeSchedule(range, { scheduledEnd: null })).toEqual({ ...range, scheduledEnd: null });
    expect(normalizeSchedule(range, { scheduledStart: null })).toEqual({ ...allDay });
    expect(normalizeSchedule(range, { dueDate: null })).toEqual(emptySchedule);
  });
  it('moves dates and starts without changing cross-midnight duration', () => {
    expect(normalizeSchedule(range, { dueDate: '2026-10-20' })).toEqual({ dueDate: '2026-10-20', scheduledStart: '2026-10-20T23:00', scheduledEnd: '2026-10-21T01:00' });
    expect(normalizeSchedule(range, { scheduledStart: '2026-10-22T22:00' })).toEqual({ dueDate: '2026-10-22', scheduledStart: '2026-10-22T22:00', scheduledEnd: '2026-10-23T00:00' });
    expect(normalizeSchedule(range, {})).toEqual(range);
  });
  it('rejects conflicting dates, orphan ends and invalid calendar times', () => {
    for (const patch of [
      { scheduledEnd: '2026-10-11T15:00' },
      { scheduledStart: '2026-10-11T15:00', scheduledEnd: '2026-10-11T15:00' },
      { scheduledStart: '2026-02-30T12:00' },
      { dueDate: '2026-10-12', scheduledStart: '2026-10-11T15:00' },
      { dueDate: null, scheduledStart: '2026-10-11T15:00' },
    ]) expect(() => normalizeSchedule(emptySchedule, patch)).toThrow();
  });
  it('restores legacy placement and excludes an end at midnight from the next day', () => {
    expect(normalizeLegacySchedule({ ...range, dueDate: '2026-11-01' }).dueDate).toBe('2026-10-11');
    expect(scheduleLastDate({ ...range, scheduledEnd: '2026-10-13T00:00' })).toBe('2026-10-12');
  });
});
