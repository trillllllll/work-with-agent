import { describe, expect, it } from 'vitest';
import { isCompleteSyncRow, mergeSyncRow, type SyncRow } from './sync-merge.js';

const task = (patch: SyncRow = {}): SyncRow => ({
  title: '原来', description: '', status: 'todo', priority: 'none', dueDate: null, estimatedMinutes: null,
  scheduledStart: null, scheduledEnd: null, resultSummary: '', recurrenceRule: '', reminderMinutesBefore: null, topicId: null, parentId: null, deletedAt: null,
  deleteBatchId: null, sortOrder: 0, tagIds: [], createdAt: null, completedAt: null, completedAtEstimated: false, ...patch,
});

describe('sync field merge', () => {
  it('keeps both edits when two devices change different fields', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ title: '甲' }), base, task({ status: 'doing' }));
    expect(merged.conflicts).toEqual([]);
    expect(merged.row).toMatchObject({ title: '甲', status: 'doing' });
  });

  it('keeps the live value and reports a conflict when the same field diverges', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ title: '甲' }), base, task({ title: '乙' }));
    expect(merged.row).toMatchObject({ title: '甲' });
    expect(merged.conflicts).toEqual([{ field: 'title', base: '原来', live: '甲', incoming: '乙' }]);
  });

  it('lets the later sort order win without a conflict', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ sortOrder: 1 }), base, task({ sortOrder: 4 }));
    expect(merged.conflicts).toEqual([]);
    expect(merged.row).toMatchObject({ sortOrder: 4 });
  });

  it('does not drop an edit when the other side deleted the task', () => {
    const base = task({ title: '原来' });
    const merged = mergeSyncRow('task', task({ title: '改过' }), base, null);
    expect(merged.row).toMatchObject({ title: '改过' });
    expect(merged.conflicts.map((item) => item.field)).toEqual(['_deleted']);
  });

  it('accepts a delete when nobody else edited the row', () => {
    const base = task();
    expect(mergeSyncRow('task', base, base, null)).toEqual({ row: null, conflicts: [] });
  });
  it('preserves the full incoming edit against an already soft-deleted task', () => {
    const base = task();
    const deleted = task({ deletedAt: '2026-10-25T00:00:00Z', deleteBatchId: 'batch' });
    const merged = mergeSyncRow('task', deleted, base, task({ description: '离线新增内容' }));
    expect(merged.row).toEqual(deleted);
    expect(merged.conflicts[0]).toMatchObject({ field: '_deleted', incoming: { description: '离线新增内容' } });
  });
  it('keeps the delete marker and batch marker unchanged when deletion conflicts', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ title: '本地修改' }), base, task({ deletedAt: '2026-10-25T00:00:00Z', deleteBatchId: 'batch' }));
    expect(merged.row).toMatchObject({ deletedAt: null, deleteBatchId: null, title: '本地修改' });
    expect(merged.conflicts[0].field).toBe('_deleted');
  });

  it('carries the recurrence rule as a synced field', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ recurrenceRule: '{"unit":"week","step":1}' }), base, task({ status: 'doing' }));
    expect(merged.row).toMatchObject({ recurrenceRule: '{"unit":"week","step":1}' });
    expect(isCompleteSyncRow('task', task({ recurrenceRule: '{"unit":"week","step":1}' }))).toBe(true);
    expect(isCompleteSyncRow('task', task({ recurrenceRule: null }))).toBe(false);
  });

  it('carries the reminder lead as a synced field with its bounds', () => {
    const base = task();
    const merged = mergeSyncRow('task', task({ reminderMinutesBefore: 30 }), base, task({ status: 'doing' }));
    expect(merged.row).toMatchObject({ reminderMinutesBefore: 30, status: 'doing' });
    expect(isCompleteSyncRow('task', task({ reminderMinutesBefore: -1 }))).toBe(true);
    expect(isCompleteSyncRow('task', task({ reminderMinutesBefore: 43200 }))).toBe(true);
    expect(isCompleteSyncRow('task', task({ reminderMinutesBefore: -2 }))).toBe(false);
    expect(isCompleteSyncRow('task', task({ reminderMinutesBefore: 43201 }))).toBe(false);
    expect(isCompleteSyncRow('task', task({ reminderMinutesBefore: '10' }))).toBe(false);
    const { reminderMinutesBefore: _dropped, ...legacy } = task();
    expect(isCompleteSyncRow('task', legacy)).toBe(false);
  });

});
