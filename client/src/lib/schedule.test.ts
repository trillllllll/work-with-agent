import { describe, expect, it } from 'vitest';
import type { Task } from './api.js';
import { applyDrop, isOverdue, layoutTimed, occursOn, resizeSchedule, scheduleLabel, shiftMonth } from './schedule.js';

const task = (patch: Partial<Task> = {}): Task => ({ id: 'task', title: '任务', description: '', topicId: null, status: 'todo', priority: 'none', allowedTransitions: [], dueDate: null, scheduledStart: null, scheduledEnd: null, estimatedMinutes: null, resultSummary: '', ...patch });
describe('calendar behavior', () => {
  const range = task({ dueDate: '2026-10-11', scheduledStart: '2026-10-11T23:00', scheduledEnd: '2026-10-12T01:00' });
  it('splits cross-day ranges and exposes only real resize endpoints', () => {
    expect(layoutTimed([range], '2026-10-11')[0]).toMatchObject({ startMin: 1380, endMin: 1440, startsHere: true, endsHere: false });
    expect(layoutTimed([range], '2026-10-12')[0]).toMatchObject({ startMin: 0, endMin: 60, startsHere: false, endsHere: true });
    const midnight = { ...range, scheduledEnd: '2026-10-12T00:00' };
    expect(layoutTimed([midnight], '2026-10-12')).toEqual([]);
    expect(occursOn(midnight, '2026-10-12')).toBe(false);
    expect(isOverdue(range, '2026-10-12')).toBe(false);
    expect(isOverdue(midnight, '2026-10-12')).toBe(true);
  });
  it('keeps points as markers and moves them without inventing an end', () => {
    const point = task({ id: 'point', dueDate: '2026-10-11', scheduledStart: '2026-10-11T23:00' });
    const blocks = layoutTimed([point, range], '2026-10-11');
    expect(blocks.find((block) => block.point)).toMatchObject({ startMin: 1380, endMin: 1380, point: true });
    expect(blocks.every((block) => !('lane' in block) && !('laneCount' in block))).toBe(true);
    expect(applyDrop(point, 'slot:2026-10-12:16:00')).toMatchObject({ dueDate: '2026-10-12', scheduledStart: '2026-10-12T16:00', scheduledEnd: null });
    expect(applyDrop(point, 'cell:2026-10-12')).toMatchObject({ scheduledStart: '2026-10-12T23:00', scheduledEnd: null });
  });
  it('preserves duration when moving; cancelling and all-day drops clear concrete times', () => {
    expect(applyDrop(range, 'slot:2026-10-20:16:00')).toMatchObject({ scheduledStart: '2026-10-20T16:00', scheduledEnd: '2026-10-20T18:00' });
    expect(applyDrop(range, 'allday:2026-10-20')).toEqual({ dueDate: '2026-10-20', scheduledStart: null, scheduledEnd: null });
    expect(applyDrop(range, 'unschedule')).toEqual({ dueDate: null, scheduledStart: null, scheduledEnd: null });
    expect(applyDrop(task({ estimatedMinutes: 90 }), 'slot:2026-10-20:16:00')?.scheduledEnd).toBe('2026-10-20T17:30');
    expect(applyDrop(task(), 'slot:2026-10-20:16:00')?.scheduledEnd).toBe('2026-10-20T17:00');
  });
  it('snaps resizing to 30 minutes, prevents inversion and clamps month navigation', () => {
    expect(resizeSchedule(range, 'end', 44)?.scheduledEnd).toBe('2026-10-12T01:30');
    expect(resizeSchedule(range, 'start', 200)?.scheduledStart).toBe('2026-10-12T00:30');
    expect(resizeSchedule(range, 'end', -200)?.scheduledEnd).toBe('2026-10-11T23:30');
    expect(resizeSchedule({ ...range, scheduledEnd: '2026-10-12T01:13' }, 'end', 30)?.scheduledEnd).toBe('2026-10-12T01:30');
    const precise = { dueDate: '2026-10-11', scheduledStart: '2026-10-11T14:13', scheduledEnd: '2026-10-11T15:13' };
    expect(resizeSchedule(precise, 'start', 200)?.scheduledStart).toBe('2026-10-11T14:30');
    expect(resizeSchedule(precise, 'end', -200)?.scheduledEnd).toBe('2026-10-11T15:00');
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonth('2028-03-31', -1)).toBe('2028-02-29');
    expect(scheduleLabel(range)).toContain('2026-10-12 01:00');
  });
});
