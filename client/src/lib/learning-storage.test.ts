import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { listLearningRecords, readLearningRecord, removeLearningRecord, writeLearningRecord, finishedCacheEvictions, pruneFinishedLearningCaches, type LearningStored } from './learning-storage.js';

describe('learning storage isolation and acknowledgements', () => {
  it('isolates the same item across accounts and workspaces', async () => {
    await writeLearningRecord('server/workspace-a/user-a', 'draft', 'item', { answer: 'private-a' });
    await writeLearningRecord('server/workspace-b/user-a', 'draft', 'item', { answer: 'private-b' });
    expect(await readLearningRecord('server/workspace-a/user-b', 'draft', 'item')).toBeUndefined();
    expect(await readLearningRecord('server/workspace-b/user-a', 'draft', 'item')).toEqual({ answer: 'private-b' });
    expect(await listLearningRecords('server/workspace-a/user-a', 'pending')).toEqual([]);
  });
  it('a late receipt cannot remove a newer snapshot', async () => {
    const old = { requestId: 'old', answer: 'first' };
    const next = { requestId: 'new', answer: 'second' };
    await writeLearningRecord('late-receipt', 'pending', 'item', old);
    await writeLearningRecord('late-receipt', 'pending', 'item', next);
    expect(await removeLearningRecord('late-receipt', 'pending', 'item', old)).toBe(false);
    expect(await readLearningRecord('late-receipt', 'pending', 'item')).toEqual(next);
    expect(await removeLearningRecord('late-receipt', 'pending', 'item', next)).toBe(true);
    expect(await readLearningRecord('late-receipt', 'pending', 'item')).toBeUndefined();
  });

  it('limits finished caches while protecting current, active and locally pending work', () => {
    const now = Date.now();
    const record = (kind: string, id: string, value: unknown, updatedAt = now): LearningStored => ({ key: `${kind}:${id}`, scope: 'scope', kind, id, value, updatedAt });
    const finished = Array.from({ length: 24 }, (_, i) => record('session', `s${i}`, { state: 'finished', items: [{ id: `i${i}` }] }, now - i));
    const records = [...finished, record('session', 'active', { state: 'active', items: [] }), record('answer', 'i21:a', { answer: 'unsaved', baseAnswer: '' }), record('answer', 'i22:a', { answer: 'same', baseAnswer: 'same', pendingSubmit: { requestId: 'unknown' } }), record('session-operation', 's23', { requestId: 'pause' })];
    expect(finishedCacheEvictions(records, 's0', now)).toEqual(['session:s20']);
    const pressure = finishedCacheEvictions(records, 's0', now, true);
    expect(pressure).not.toContain('session:active');
    for (const id of ['s0', 's21', 's22', 's23']) expect(pressure).not.toContain(`session:${id}`);
    expect(pressure.every(key => key.startsWith('session:'))).toBe(true);
  });

  it('prunes only this scope’s recoverable cache and never its original answer records', async () => {
    await writeLearningRecord('cache-clean', 'session', 'old', { state: 'finished', items: [{ id: 'item' }] });
    await writeLearningRecord('cache-clean', 'answer', 'item:a', { answer: 'saved', baseAnswer: 'saved' });
    await writeLearningRecord('cache-other', 'session', 'old', { state: 'finished', items: [] });
    expect(await pruneFinishedLearningCaches('cache-clean', 'current', true)).toBe(1);
    expect(await readLearningRecord('cache-clean', 'session', 'old')).toBeUndefined();
    expect(await readLearningRecord('cache-clean', 'answer', 'item:a')).toEqual({ answer: 'saved', baseAnswer: 'saved' });
    expect(await readLearningRecord('cache-other', 'session', 'old')).toBeDefined();
  });
});
