import { describe, expect, it } from 'vitest';
import { captureDraftKey, createWriteQueue, draftPatch, isCompositionKey, keepNewestTask, localDate, mergeTaskDraft, taskDraft } from './todo.js';
import type { Task } from './api.js';

const task: Task = { id: 'a', topicId: null, title: '原任务', description: '', status: 'todo', allowedTransitions: ['doing', 'done'], priority: 'none', dueDate: null, resultSummary: '', revision: 1, tagIds: ['a', 'b'] };

describe('task edit data flow', () => {
  it('sends only changed fields and preserves explicit clearing', () => {
    const base = taskDraft({ ...task, dueDate: '2026-09-20' });
    expect(draftPatch(base, { ...base, title: '新标题' })).toEqual({ title: '新标题' });
    expect(draftPatch(base, { ...base, dueDate: null, tagIds: [] })).toEqual({ dueDate: null, tagIds: [] });
    expect(draftPatch(base, { ...base, tagIds: ['b', 'a'] })).toEqual({});
  });
  it('merges clean fields while retaining edited fields and reporting real conflicts', () => {
    const base = taskDraft(task);
    const draft = { ...base, title: '我的编辑' };
    const incoming = { ...base, title: '后台编辑', priority: 'high' as const };
    expect(mergeTaskDraft(base, draft, incoming)).toEqual({ draft: { ...draft, priority: 'high' }, conflicts: ['title'] });
    expect(mergeTaskDraft(base, draft, { ...base, title: '我的编辑' }).conflicts).toEqual([]);
  });
  it('ignores older task responses', () => {
    const newer = { ...task, revision: 3, title: '更新' };
    expect(keepNewestTask(newer, task)).toBe(newer);
    expect(keepNewestTask(task, newer)).toBe(newer);
  });
});

describe('task write queue', () => {
  it('serializes overlapping grouped writes and continues after failure', async () => {
    const queue = createWriteQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue(['parent', 'child'], async () => { order.push('first'); await gate; throw new Error('failed'); });
    const second = queue(['child'], async () => { order.push('second'); return 2; });
    const other = queue(['unrelated'], async () => { order.push('other'); });
    await other;
    expect(order).toEqual(['first', 'other']);
    release();
    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first', 'other', 'second']);
  });
});

describe('capture and dates', () => {
  it('isolates drafts by list and parent', () => {
    expect(new Set([captureDraftKey(null, null), captureDraftKey('topic', null), captureDraftKey('topic', 'parent')]).size).toBe(3);
  });
  it('suppresses IME composition, legacy 229 and repeat Enter', () => {
    expect(isCompositionKey({ isComposing: true })).toBe(true);
    expect(isCompositionKey({ keyCode: 229 })).toBe(true);
    expect(isCompositionKey({ repeat: true })).toBe(true);
    expect(isCompositionKey({ keyCode: 13 })).toBe(false);
  });
  it('uses local calendar fields, including the midnight boundary', () => {
    expect(localDate(new Date(2026, 8, 20, 23, 59, 59))).toBe('2026-09-20');
    expect(localDate(new Date(2026, 8, 21, 0, 0, 0))).toBe('2026-09-21');
  });
});
