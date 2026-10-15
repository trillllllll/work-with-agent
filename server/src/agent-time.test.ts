import { describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { DomainError } from './domain/task.js';
import { normalizeSchedule } from './domain/schedule.js';
import { getCurrentTime } from './agent/time.js';

const api = request(app);

describe('current time and schedule normalization', () => {
  it('formats Shanghai local time from an injected clock', () => {
    expect(getCurrentTime({ timeZone: 'Asia/Shanghai' }, {}, { now: () => new Date('2026-10-15T03:00:00.000Z') })).toEqual({
      utc: '2026-10-15T03:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      timeZoneSource: 'argument',
      localDate: '2026-10-15',
      localTime: '11:00:00',
      localDateTime: '2026-10-15T11:00:00',
      utcOffsetMinutes: 480,
      weekdayIso: 4,
    });
  });

  it('uses the context zone, then the Shanghai default, and rejects an illegal zone', () => {
    expect(getCurrentTime({}, { timeZone: 'UTC' }, { now: () => new Date('2026-10-15T03:00:00.000Z') })).toMatchObject({ timeZone: 'UTC', timeZoneSource: 'context', localTime: '03:00:00', utcOffsetMinutes: 0 });
    expect(getCurrentTime({}, {}, { now: () => new Date('2026-10-15T03:00:00.000Z') })).toMatchObject({ timeZone: 'Asia/Shanghai', timeZoneSource: 'default', localDate: '2026-10-15' });
    expect(() => getCurrentTime({ timeZone: 'Not/AZone' }, {}, { now: () => new Date('2026-10-15T03:00:00.000Z') })).toThrowError(expect.objectContaining({ code: 'INVALID_TIME_ZONE' }));
  });

  it('moves a range with its duration when only the date changes, including across midnight and a leap day', () => {
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T23:00', scheduledEnd: '2026-10-16T01:00' }, { dueDate: '2026-10-16' })).toEqual({
      dueDate: '2026-10-16', scheduledStart: '2026-10-16T23:00', scheduledEnd: '2026-10-17T01:00',
    });
    expect(normalizeSchedule({ dueDate: '2024-02-28', scheduledStart: '2024-02-28T22:00', scheduledEnd: '2024-02-29T01:00' }, { dueDate: '2024-02-29' })).toEqual({
      dueDate: '2024-02-29', scheduledStart: '2024-02-29T22:00', scheduledEnd: '2024-03-01T01:00',
    });
  });

  it('clears the whole range when the date is cleared and keeps estimated minutes independent', () => {
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' }, { dueDate: null })).toEqual({
      dueDate: null, scheduledStart: null, scheduledEnd: null,
    });
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' }, {})).toEqual({
      dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00',
    });
  });

  it('keeps duration when only the start moves, becomes a point when the end is cleared, and becomes all-day when the start is cleared', () => {
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' }, { scheduledStart: '2026-10-15T15:00' })).toEqual({
      dueDate: '2026-10-15', scheduledStart: '2026-10-15T15:00', scheduledEnd: '2026-10-15T16:00',
    });
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' }, { scheduledEnd: null })).toEqual({
      dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: null,
    });
    expect(normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' }, { scheduledStart: null })).toEqual({
      dueDate: '2026-10-15', scheduledStart: null, scheduledEnd: null,
    });
  });

  it('rejects a start that is not before the end', () => {
    expect(() => normalizeSchedule({ dueDate: '2026-10-15', scheduledStart: '2026-10-15T12:00', scheduledEnd: '2026-10-15T11:00' }, {})).toThrow(DomainError);
  });

  it('keeps estimated minutes off the schedule and excludes a range that ends at the next midnight', async () => {
    const stamp = `boundary-${Date.now()}`;
    const estimate = await api.post('/api/tasks').send({ title: `${stamp}-estimate`, estimatedMinutes: 60 });
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
    expect(estimate.body.data).toMatchObject({ estimatedMinutes: 60, dueDate: null, scheduledStart: null, scheduledEnd: null });

    const overnight = await api.post('/api/tasks').send({
      title: `${stamp}-overnight`,
      dueDate: '2026-10-15',
      scheduledStart: '2026-10-15T23:00',
      scheduledEnd: '2026-10-16T00:00',
    });
    expect(overnight.status, JSON.stringify(overnight.body)).toBe(200);
    const onStart = await api.get('/api/tasks').query({ q: `${stamp}-overnight`, scheduledFrom: '2026-10-15', scheduledTo: '2026-10-15' });
    const onEnd = await api.get('/api/tasks').query({ q: `${stamp}-overnight`, scheduledFrom: '2026-10-16', scheduledTo: '2026-10-16' });
    expect(onStart.status, JSON.stringify(onStart.body)).toBe(200);
    expect(onEnd.status, JSON.stringify(onEnd.body)).toBe(200);
    expect(onStart.body.data.map((task: { id: string }) => task.id)).toContain(overnight.body.data.id);
    expect(onEnd.body.data.map((task: { id: string }) => task.id)).not.toContain(overnight.body.data.id);
  });
});
