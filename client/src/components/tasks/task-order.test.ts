import { describe, expect, it } from 'vitest';
import { projectTaskDrop, reorderTaskGroup, withSortOrder, type OrderRow } from './task-order.js';

const group = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('reorderTaskGroup', () => {
  it('moves an earlier task down onto the later index', () => {
    expect(reorderTaskGroup(group, 'a', 'c')?.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves a later task up onto the earlier index', () => {
    expect(reorderTaskGroup(group, 'c', 'a')?.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('returns null when the task stays or the target is outside the group', () => {
    expect(reorderTaskGroup(group, 'a', 'a')).toBeNull();
    expect(reorderTaskGroup(group, 'a', 'missing')).toBeNull();
    expect(reorderTaskGroup(group, 'missing', 'b')).toBeNull();
  });
});

const tree: OrderRow[] = [
  { id: 'A', parentId: null, hasChildren: true },
  { id: 'a1', parentId: 'A', hasChildren: false },
  { id: 'a2', parentId: 'A', hasChildren: false },
  { id: 'B', parentId: null, hasChildren: false },
  { id: 'C', parentId: null, hasChildren: true },
  { id: 'c1', parentId: 'C', hasChildren: false },
];

describe('projectTaskDrop', () => {
  it('indents a root under the root above when dragged right', () => {
    expect(projectTaskDrop(tree, 'B', 'B', 30)).toEqual({ parentId: 'A', orderedIds: ['a1', 'a2', 'B'] });
  });

  it('keeps the first root in place when dragged right', () => {
    expect(projectTaskDrop(tree, 'A', 'A', 40)).toBeNull();
  });

  it('reorders a root that already has children without indenting it', () => {
    expect(projectTaskDrop(tree, 'A', 'B', 40)).toEqual({ parentId: null, orderedIds: ['B', 'A', 'C'] });
  });

  it('outdents a child to the root gap when dragged left', () => {
    expect(projectTaskDrop(tree, 'a2', 'a2', -30)).toEqual({ parentId: null, orderedIds: ['A', 'a2', 'B', 'C'] });
  });

  it('moves a child into another root’s children while staying indented', () => {
    expect(projectTaskDrop(tree, 'a1', 'c1', 0)).toEqual({ parentId: 'C', orderedIds: ['c1', 'a1'] });
  });

  it('reorders siblings when the horizontal move stays under the threshold', () => {
    expect(projectTaskDrop(tree, 'a2', 'a1', 8)).toEqual({ parentId: 'A', orderedIds: ['a2', 'a1'] });
  });
});

describe('withSortOrder', () => {
  it('writes sibling indexes and leaves unrelated tasks as the same object', () => {
    const order = new Map([['b', 0], ['a', 1]]);
    const parent = { id: 'p', sortOrder: 4, children: [{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 1 }, { id: 'z', sortOrder: 2 }] };
    const next = withSortOrder(parent, order);
    expect(next.sortOrder).toBe(4);
    expect(next.children?.map((child) => [child.id, child.sortOrder])).toEqual([['a', 1], ['b', 0], ['z', 2]]);
    expect(next.children?.[2]).toBe(parent.children[2]);
    expect(withSortOrder({ id: 'z', sortOrder: 3 }, order)).toEqual({ id: 'z', sortOrder: 3 });
  });
});
