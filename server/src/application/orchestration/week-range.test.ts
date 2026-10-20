import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/task.js';
import { weekRange } from './week-range.js';

describe('weekRange', () => {
  it('uses Monday 00:00 in Asia/Shanghai through the next Monday', () => {
    const now = new Date('2026-10-21T07:00:00.000Z');
    expect(weekRange(now, 'Asia/Shanghai')).toEqual({ from: '2026-10-18T16:00:00.000Z', to: '2026-10-25T16:00:00.000Z' });
    expect(weekRange(new Date('2026-10-25T15:00:00.000Z'), 'Asia/Shanghai').from).toBe('2026-10-18T16:00:00.000Z');
    expect(weekRange(new Date('2026-10-25T16:00:00.000Z'), 'Asia/Shanghai')).toEqual({ from: '2026-10-25T16:00:00.000Z', to: '2026-11-01T16:00:00.000Z' });
  });

  it('shifts by whole weeks and keeps a DST week at its real length', () => {
    const now = new Date('2026-10-21T07:00:00.000Z');
    const current = weekRange(now, 'Asia/Shanghai', 0);
    expect(weekRange(now, 'Asia/Shanghai', -1).to).toBe(current.from);
    const fall = weekRange(new Date('2026-10-28T16:00:00.000Z'), 'America/New_York');
    expect(fall).toEqual({ from: '2026-10-26T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe(169 * 60 * 60 * 1000);
    const spring = weekRange(new Date('2026-03-04T17:00:00.000Z'), 'America/New_York');
    expect(spring).toEqual({ from: '2026-03-02T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(167 * 60 * 60 * 1000);
  });

  it('rejects an unknown time zone', () => {
    expect(() => weekRange(new Date(), 'Not/AZone')).toThrow(DomainError);
    try { weekRange(new Date(), 'Not/AZone'); } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_TIME_ZONE', message: '时区无效' });
    }
  });
});
