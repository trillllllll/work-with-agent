import { arrayMove } from '@dnd-kit/sortable';

type OrderedTask = { id: string; sortOrder?: number; children?: OrderedTask[] };

export const dragIndentThreshold = 20;
export const dragIndentOffset = 28;

export type OrderRow = { id: string; parentId: string | null; hasChildren: boolean };
export type DropProjection = { parentId: string | null; orderedIds: string[] };

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function idsForParent(moved: string[], rows: OrderRow[], activeId: string, parentId: string | null) {
  return moved.filter((id) => id === activeId || (rows.find((row) => row.id === id)?.parentId ?? null) === parentId);
}

export function reorderTaskGroup<T extends { id: string }>(group: T[], activeId: string, overId: string): T[] | null {
  const from = group.findIndex((item) => item.id === activeId);
  const to = group.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(group, from, to);
}

export function projectTaskDrop(rows: OrderRow[], activeId: string, overId: string, deltaX: number): DropProjection | null {
  const active = rows.find((row) => row.id === activeId);
  const overIsVisible = rows.some((row) => row.id === overId);
  if (!active || !overIsVisible || rows.some((row) => row.id === overId && row.parentId === activeId)) return null;
  if (active.hasChildren) {
    const roots = rows.filter((row) => row.parentId === null);
    const next = reorderTaskGroup(roots, activeId, overId);
    return next ? { parentId: null, orderedIds: next.map((row) => row.id) } : null;
  }
  const ids = rows.map((row) => row.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  const moved = from < 0 || to < 0 || from === to ? ids : arrayMove(ids, from, to);
  const index = moved.indexOf(activeId);
  const previous = index > 0 ? rows.find((row) => row.id === moved[index - 1]) : undefined;
  let parentId: string | null = null;
  const indent = deltaX > dragIndentThreshold;
  const outdent = deltaX < -dragIndentThreshold;
  let nested = Boolean(active.parentId) && !outdent;
  if (!active.parentId && indent) nested = true;
  if (nested) {
    const candidate = previous ? previous.parentId ?? previous.id : null;
    const parent = rows.find((row) => row.id === candidate);
    parentId = parent && !parent.parentId && parent.id !== activeId ? parent.id : null;
    if (!parentId) nested = false;
  }
  const orderedIds = idsForParent(moved, rows, activeId, nested ? parentId : null);
  const currentParent = active.parentId;
  const currentOrder = rows.filter((row) => (currentParent ? row.parentId === currentParent : !row.parentId)).map((row) => row.id);
  if ((nested ? parentId : null) === currentParent && sameIds(orderedIds, currentOrder)) return null;
  return { parentId: nested ? parentId : null, orderedIds };
}

export function withSortOrder<T extends OrderedTask>(task: T, order: ReadonlyMap<string, number>): T {
  const sortOrder = order.get(task.id);
  const children = task.children?.map((child) => withSortOrder(child, order)) as T['children'];
  const sortChanged = sortOrder !== undefined && sortOrder !== task.sortOrder;
  const childrenChanged = children?.some((child, index) => child !== task.children?.[index]) ?? false;
  if (!sortChanged && !childrenChanged) return task;
  return { ...task, ...(sortChanged ? { sortOrder } : {}), ...(children ? { children } : {}) };
}
