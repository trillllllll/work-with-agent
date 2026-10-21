import { describe, expect, it } from 'vitest';
import { decideQueuedLeave, editingAfterSuccessfulSave, isMetaDirty, type MetaDraft, type MetaEditing } from './task-leave.js';

function meta(patch: Partial<MetaDraft> = {}): MetaDraft {
  return {
    status: 'todo',
    priority: 'none',
    dueDate: null,
    estimatedMinutes: null,
    scheduledStart: null,
    scheduledEnd: null,
    resultSummary: '',
    topicId: null,
    parentId: null,
    tagIds: [],
    ...patch,
  };
}

function editing(draft: Partial<MetaDraft>, base: Partial<MetaDraft> = {}, conflicts: string[] = []): MetaEditing {
  return { base: meta(base), draft: meta({ ...base, ...draft }), conflicts };
}

describe('decideQueuedLeave', () => {
  it('保存中离开，保存成功且不再脏时执行离开', () => {
    const current = editing({ tagIds: ['label'] });
    expect(isMetaDirty(current)).toBe(true);
    const next = editingAfterSuccessfulSave(current, meta({ tagIds: ['label'] }));
    expect(isMetaDirty(next)).toBe(false);
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: isMetaDirty(next), saveFailed: false })).toBe('leave');
  });

  it('标签顺序不同也不算未保存', () => {
    const next = editingAfterSuccessfulSave(editing({ tagIds: ['b', 'a'] }), meta({ tagIds: ['a', 'b'] }));
    expect(isMetaDirty(next)).toBe(false);
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: isMetaDirty(next), saveFailed: false })).toBe('leave');
  });

  it('保存成功但仍有脏改动时弹窗', () => {
    const current = editing({ tagIds: ['label'], priority: 'high' });
    const next = editingAfterSuccessfulSave(current, meta({ tagIds: ['label'], priority: 'none' }));
    expect(isMetaDirty(next)).toBe(true);
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: isMetaDirty(next), saveFailed: false })).toBe('confirm');
    const savedTags = editingAfterSuccessfulSave(editing({ tagIds: ['label'] }), meta({ tagIds: ['label'] }));
    expect(isMetaDirty(savedTags)).toBe(false);
    // 调用方确认仍有未保存的元数据时传 dirty。正文是否能离开由 prepareLeave 另判。
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: true, saveFailed: false })).toBe('confirm');
  });

  it('保存失败时弹窗，即使回滚后草稿已经不脏', () => {
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: true, saveFailed: true })).toBe('confirm');
    expect(decideQueuedLeave({ hasPending: true, savingCount: 0, dirty: false, saveFailed: true })).toBe('confirm');
  });

  it('还有别的保存没结束时继续等', () => {
    expect(decideQueuedLeave({ hasPending: true, savingCount: 1, dirty: false, saveFailed: false })).toBe('wait');
    expect(decideQueuedLeave({ hasPending: false, savingCount: 0, dirty: true, saveFailed: true })).toBe('wait');
  });
});
