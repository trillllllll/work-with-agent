import { arrayMove } from '@dnd-kit/sortable';

type OrderedTask = { id: string; sortOrder?: number; children?: OrderedTask[] };

export const dragIndentThreshold = 20;
export const dragIndentOffset = 24;

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

// Keep the visible proposal intact and append siblings it did not include.
export function completeSiblingIds(proposedIds: string[], siblingIds: string[]): string[] {
  const present = new Set(proposedIds);
  return [...proposedIds, ...siblingIds.filter((id) => !present.has(id))];
}

export const sortTasks = <T extends { id: string; sortOrder?: number }>(tasks: T[]) => [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));

/** 把“上移/下移”得到的分组补全成完整同级顺序：保留提案里的先后，再接上没包含的兄弟（折叠、已完成或没显示的）。 */
export function completeReorder<T extends { id: string; parentId?: string | null }>(ordered: T[], moved: T[], parentId: string | null): T[] {
  const siblingIds = ordered.filter((task) => (task.parentId ?? null) === parentId).map((task) => task.id);
  const byId = new Map([...ordered, ...moved].map((task) => [task.id, task] as const));
  return completeSiblingIds(moved.map((task) => task.id), siblingIds).flatMap((id) => byId.get(id) ?? []);
}

/**
 * 某个任务在手动排序列表里的同级分组与位置，和任务行“上移/下移”用的一致：
 * 根任务（含父任务不在列表里的）一组，折叠已完成时已完成的另算；子任务按父任务分组。任务不在列表里时返回 null。
 */
export function menuSiblings<T extends { id: string; parentId?: string | null; status?: string }>(ordered: T[], taskId: string, foldDone: boolean): { group: T[]; index: number } | null {
  const nested = (task: T) => Boolean(task.parentId) && ordered.some((parent) => parent.id === task.parentId);
  const task = ordered.find((item) => item.id === taskId);
  if (!task) return null;
  const group = nested(task)
    ? ordered.filter((item) => (item.parentId ?? null) === task.parentId)
    : ordered.filter((item) => !nested(item) && (!foldDone || (item.status === 'done') === (task.status === 'done')));
  const index = group.findIndex((item) => item.id === taskId);
  return index < 0 ? null : { group, index };
}

export function projectTaskDrop(rows: OrderRow[], activeId: string, overId: string, deltaX: number): DropProjection | null {
  const active = rows.find((row) => row.id === activeId);
  const overIsVisible = rows.some((row) => row.id === overId);
  if (!active || !overIsVisible || rows.some((row) => row.id === overId && row.parentId === activeId)) return null;
  // A task that already has children stays at its current level. Only one level is supported.
  if (active.hasChildren) {
    const parentId = active.parentId;
    const siblings = rows.filter((row) => row.parentId === parentId);
    const next = reorderTaskGroup(siblings, activeId, overId);
    return next ? { parentId, orderedIds: next.map((row) => row.id) } : null;
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
