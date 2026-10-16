import { describe, expect, it } from 'vitest';
import { groupTimedBlocks } from './plan-layout.js';
import { layoutTimed } from './schedule.js';
import type { Task } from './api.js';

const task = (id: string, start: string, end: string | null) => ({ id, scheduledStart: start, scheduledEnd: end, dueDate: start.slice(0, 10) }) as Task;

describe('weekly overlap groups', () => {
  it('groups connected overlaps while keeping adjacent tasks separate', () => {
    const rows = [task('a', '2026-10-17T10:00', '2026-10-17T11:00'), task('b', '2026-10-17T10:30', '2026-10-17T12:00'), task('c', '2026-10-17T11:30', '2026-10-17T12:30'), task('d', '2026-10-17T12:30', '2026-10-17T13:00')];
    expect(groupTimedBlocks(layoutTimed(rows, '2026-10-17')).map((group) => group.map((block) => block.task.id))).toEqual([['a', 'b', 'c'], ['d']]);
  });
  it('keeps point labels and overnight continuations reachable', () => {
    const rows = [task('overnight', '2026-10-17T23:00', '2026-10-18T01:00'), task('point', '2026-10-18T00:30', null), task('later', '2026-10-18T01:00', null)];
    expect(groupTimedBlocks(layoutTimed(rows, '2026-10-18')).map((group) => group.map((block) => block.task.id))).toEqual([['overnight', 'point'], ['later']]);
    expect(groupTimedBlocks([])).toEqual([]);
  });
});
