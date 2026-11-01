import { describe, expect, it } from 'vitest';
import { figureNodeState, figurePick } from './learning-figure.js';
import type { LearningNode } from './learning-model.js';

const node = (id: string, kind: 'item' | 'topic', status = 'todo'): LearningNode => ({ id, mapId: 'm', parentId: null, kind, title: id.toUpperCase(), detail: '', status, mastery: 0, sortOrder: 0, revision: 1, children: [] });
const nodes = [node('a', 'item', 'learning'), node('b', 'item', 'done'), node('g', 'topic')];

describe('learning figure state', () => {
  it('colours tagged items by saved status and marks the current and selected ones', () => {
    expect(figureNodeState('a', nodes, 'a', 'b')).toEqual({ status: 'learning', current: true, selected: false, title: 'A' });
    expect(figureNodeState('b', nodes, 'a', 'b')).toMatchObject({ status: 'done', selected: true });
  });
  it('treats unknown ids and groups as missing and never opens them', () => {
    expect(figureNodeState('zzz', nodes)).toBeNull();
    expect(figureNodeState('g', nodes)).toBeNull();
    expect(figurePick('zzz', nodes)).toBeNull();
    expect(figurePick('g', nodes)).toBeNull();
    expect(figurePick(undefined, nodes)).toBeNull();
    expect(figurePick('a', nodes)).toBe('a');
  });
});
