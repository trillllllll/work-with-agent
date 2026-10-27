import { describe, expect, it } from 'vitest';
import { descendants, flattenTree, getMastery, masterySummary } from './learning-model.js';
import { draftDirty, freshDraft, rebaseDraft } from './note-draft.js';
import type { LearningTreeNode } from './learning-tree.js';
const node = (id: string, values: Partial<LearningTreeNode> = {}): LearningTreeNode => ({ id, mapId: 'map', parentId: null, kind: 'item', title: id, detail: 'original', status: 'todo', mastery: 100, sortOrder: 0, revision: 1, children: [], ...values });
describe('learning states and note conflicts', () => {
  it('uses the explicit state even when the legacy numeric score disagrees', () => {
    expect(getMastery(node('a')).id).toBe('todo');
    expect(getMastery(node('b', { status: 'review', mastery: 0 })).id).toBe('review');
    expect(getMastery(node('c', { status: 'old-value' })).id).toBe('todo');
  });
  it('aggregates nested knowledge points without counting groups or unrelated branches', () => {
    const tree = [node('group', { kind: 'topic', children: [node('nested', { parentId: 'group', kind: 'topic', children: [node('a', { parentId: 'nested', status: 'done' })] }),node('b', { parentId: 'group',status: 'review' })] }),node('other',{ status: 'done' })];
    const nodes = flattenTree(tree);
    expect(descendants(nodes,'group').map(n => n.id)).toEqual(['nested','a','b']);
    expect(masterySummary(nodes,'group')).toEqual({ done: 1,total: 2 });
    expect(masterySummary(nodes)).toEqual({ done: 2,total: 3 });
  });
  it('merges only locally edited fields and keeps remote status changes', () => {
    const original = node('a');
    const draft = { ...freshDraft(original), detail: 'my note', pending: { requestId: 'retry',command: { kind: 'learning.node.update' } } };
    const remote = node('a',{ revision: 2,status: 'review',title: 'AI title' });
    const rebased = rebaseDraft(draft,remote);
    expect(rebased).toMatchObject({ detail: 'my note',title: 'AI title',status: 'review',revision: 2 });
    expect(rebased.pending).toBeUndefined();
    expect(rebased.base.detail).toBe('original');
    expect(draftDirty(rebased)).toBe(true);
    expect(draftDirty(freshDraft(remote))).toBe(false);
  });
});
