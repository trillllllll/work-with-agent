import { describe, expect, it } from 'vitest';
import { completeReorder, completeSiblingIds, menuSiblings, projectTaskDrop, reorderTaskGroup, sortTasks, withSortOrder, type OrderRow } from './task-order.js';

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

  it('moves a completed sibling through the mixed order', () => {
    const mixed = [
      { id: 'A', status: 'todo' },
      { id: 'B', status: 'done' },
      { id: 'C', status: 'todo' },
    ];
    expect(reorderTaskGroup(mixed, 'B', 'A')).toEqual([mixed[1], mixed[0], mixed[2]]);
    expect(reorderTaskGroup(mixed, 'B', 'C')).toEqual([mixed[0], mixed[2], mixed[1]]);
    expect(reorderTaskGroup(mixed, 'B', 'B')).toBeNull();
  });
});

describe('completeSiblingIds', () => {
  it('keeps a proposal that already lists every sibling', () => {
    expect(completeSiblingIds(['B', 'A', 'C'], ['A', 'B', 'C'])).toEqual(['B', 'A', 'C']);
  });

  it('appends hidden siblings without rearranging the proposal', () => {
    expect(completeSiblingIds(['P'], ['P', 'Q'])).toEqual(['P', 'Q']);
    expect(completeSiblingIds(['C', 'A'], ['A', 'B', 'C'])).toEqual(['C', 'A', 'B']);
  });
});

describe('sortTasks', () => {
  it('orders by sortOrder, breaks ties by id and leaves the input alone', () => {
    const tasks = [{ id: 'b', sortOrder: 2 }, { id: 'c', sortOrder: 1 }, { id: 'a', sortOrder: 1 }];
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['a', 'c', 'b']);
    expect(tasks.map((task) => task.id)).toEqual(['b', 'c', 'a']);
  });
});

type Entry = { id: string; parentId: string | null; status: string };
const list: Entry[] = [
  { id: 'A', parentId: null, status: 'todo' },
  { id: 'a1', parentId: 'A', status: 'todo' },
  { id: 'a2', parentId: 'A', status: 'done' },
  { id: 'B', parentId: null, status: 'done' },
  { id: 'C', parentId: null, status: 'todo' },
  { id: 'orphan', parentId: 'gone', status: 'todo' },
];
const ids = (tasks: Array<{ id: string }>) => tasks.map((task) => task.id);

describe('menuSiblings', () => {
  it('groups open roots the way the list shows them and keeps a parentless task among them', () => {
    const open = menuSiblings(list, 'C', true);
    expect(ids(open!.group)).toEqual(['A', 'C', 'orphan']);
    expect(open!.index).toBe(1);
  });

  it('keeps a folded completed root with the other completed roots', () => {
    expect(menuSiblings(list, 'B', true)).toEqual({ group: [list[3]], index: 0 });
  });

  it('includes completed roots when they are not folded', () => {
    const open = menuSiblings(list, 'C', false);
    expect(ids(open!.group)).toEqual(['A', 'B', 'C', 'orphan']);
    expect(open!.index).toBe(2);
  });

  it('groups a subtask under its parent whether or not it is completed', () => {
    const child = menuSiblings(list, 'a2', true);
    expect(ids(child!.group)).toEqual(['a1', 'a2']);
    expect(child!.index).toBe(1);
  });

  it('returns null for a task that is not in the list', () => {
    expect(menuSiblings(list, 'missing', true)).toBeNull();
  });
});

describe('completeReorder', () => {
  it('keeps the proposal and appends the siblings it left out', () => {
    expect(ids(completeReorder(list, [list[4], list[0]], null))).toEqual(['C', 'A', 'B']);
  });

  it('leaves a task whose parent is missing out of the root scope unless it moved itself', () => {
    expect(ids(completeReorder(list, [list[0], list[5], list[4]], null))).toEqual(['A', 'orphan', 'C', 'B']);
  });

  it('limits the scope to the given parent and keeps the moved copy', () => {
    const moved = [{ ...list[2], revision: 7 }];
    const complete = completeReorder(list, moved, 'A');
    expect(ids(complete)).toEqual(['a2', 'a1']);
    expect(complete[0]).toBe(moved[0]);
  });

  it('submits the folded completed sibling when a menu move only saw the open roots', () => {
    const { group } = menuSiblings(list, 'C', true)!;
    const moved = reorderTaskGroup(group, 'C', 'A')!;
    expect(ids(moved)).toEqual(['C', 'A', 'orphan']);
    expect(ids(completeReorder(list, moved, null))).toEqual(['C', 'A', 'orphan', 'B']);
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

  it('does not nest a task that already has children, even a legacy subtask', () => {
    const rows: OrderRow[] = [
      { id: 'A', parentId: null, hasChildren: true },
      { id: 'a1', parentId: 'A', hasChildren: true },
      { id: 'a2', parentId: 'A', hasChildren: false },
      { id: 'B', parentId: null, hasChildren: false },
    ];
    expect(projectTaskDrop(rows, 'a1', 'B', 40)).toBeNull();
    expect(projectTaskDrop(rows, 'a1', 'a2', 40)).toEqual({ parentId: 'A', orderedIds: ['a2', 'a1'] });
    expect(projectTaskDrop(rows, 'B', 'a1', 40)).toEqual({ parentId: 'A', orderedIds: ['B', 'a1', 'a2'] });
  });

  it('reorders a completed child among its mixed siblings', () => {
    const rows: OrderRow[] = [
      { id: 'P', parentId: null, hasChildren: true },
      { id: 'A', parentId: 'P', hasChildren: false },
      { id: 'B', parentId: 'P', hasChildren: false },
      { id: 'C', parentId: 'P', hasChildren: false },
    ];
    expect(projectTaskDrop(rows, 'B', 'A', 0)).toEqual({ parentId: 'P', orderedIds: ['B', 'A', 'C'] });
    expect(projectTaskDrop(rows, 'B', 'C', 0)).toEqual({ parentId: 'P', orderedIds: ['A', 'C', 'B'] });
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
