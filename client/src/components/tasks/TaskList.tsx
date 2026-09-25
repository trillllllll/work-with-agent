import { forwardRef, useRef, useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type DraggableSyntheticListeners } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarDays, GripVertical } from 'lucide-react';
import type { Tag, Task, Topic } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import type { TaskDraft } from '@/lib/todo.js';
import { cn } from '@/lib/utils.js';
import { dragIndentOffset, projectTaskDrop, reorderTaskGroup, type OrderRow } from './task-order.js';
import { TaskActions, TaskMenuButton, type TaskActionProps } from './TaskActionsMenu.js';

type Props = { tasks: Task[]; topics: Topic[]; tags: Tag[]; onOpen: (id: string) => void; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>; onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>; onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>; onNest?: (task: Task, parentId: string | null, orderedIds: string[]) => Promise<unknown>; onDragSettled?: () => void; hierarchical?: boolean; foldDone?: boolean; readonly?: boolean; busy?: boolean; selectedTaskId?: string; textDirty?: boolean };
type Actions = Pick<Props, 'topics' | 'tags' | 'onOpen' | 'onToggle' | 'onMove' | 'onDelete' | 'onSave' | 'onCreate' | 'onReorder' | 'hierarchical' | 'readonly' | 'busy' | 'selectedTaskId' | 'textDirty'> & { dropParentId?: string };

const levelCollision: CollisionDetection = (args) => {
  const data = args.active.data.current;
  const containers = !data?.hierarchical || data.hasChildren
    ? args.droppableContainers.filter((container) => container.data.current?.groupId === data?.groupId)
    : args.droppableContainers.filter((container) => container.data.current?.hierarchical);
  const scoped = { ...args, droppableContainers: containers };
  const hits = pointerWithin(scoped);
  if (hits.length < 2) return hits.length ? hits : closestCenter(scoped);
  return [...hits].sort((left, right) => {
    const a = args.droppableRects.get(left.id);
    const b = args.droppableRects.get(right.id);
    return (a ? a.width * a.height : Number.POSITIVE_INFINITY) - (b ? b.width * b.height : Number.POSITIVE_INFINITY);
  }).slice(0, 1);
};
const sortTasks = (tasks: Task[]) => [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
function stopDrag(event: { stopPropagation: () => void }) { event.stopPropagation(); }

export function TaskList({ tasks, topics, tags, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder, onNest, onDragSettled, hierarchical = false, foldDone = false, readonly = false, busy, selectedTaskId, textDirty }: Props) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const skipClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; width: number; overId: string; x: number } | null>(null);
  const ordered = hierarchical || onReorder ? sortTasks(tasks) : tasks;
  const roots = hierarchical ? ordered.filter((task) => !task.parentId || !ordered.some((parent) => parent.id === task.parentId)) : ordered;
  const visibleRoots = foldDone ? roots.filter((task) => task.status !== 'done') : roots;
  const foldedRoots = foldDone ? roots.filter((task) => task.status === 'done') : [];
  const childrenOf = (parentId: string) => ordered.filter((task) => task.parentId === parentId);
  const openChildrenOf = (parentId: string) => foldDone ? childrenOf(parentId).filter((task) => task.status !== 'done') : childrenOf(parentId);
  const doneChildrenOf = (parentId: string) => foldDone ? childrenOf(parentId).filter((task) => task.status === 'done') : [];
  const rows: OrderRow[] = visibleRoots.flatMap((root) => {
    const children = openChildrenOf(root.id);
    return [{ id: root.id, parentId: null, hasChildren: children.length > 0 }, ...children.map((child): OrderRow => ({ id: child.id, parentId: root.id, hasChildren: false }))];
  });
  const projection = drag && hierarchical && onNest ? projectTaskDrop(rows, drag.id, drag.overId, drag.x) : null;
  const activeRow = drag ? rows.find((row) => row.id === drag.id) : undefined;
  const shift = projection && activeRow ? (projection.parentId && !activeRow.parentId ? dragIndentOffset : !projection.parentId && activeRow.parentId ? -dragIndentOffset : 0) : 0;
  const resting = { topics, tags, onOpen, onToggle, onMove, onDelete, onSave, onCreate, hierarchical, readonly, busy, selectedTaskId, textDirty, skipClick, dropParentId: '' };
  function openGroup(groupId: string) {
    if (groupId === 'root' || groupId === 'flat') return visibleRoots;
    return openChildrenOf(groupId);
  }
  function withCompleted(group: Task[], parentId: string | null) {
    if (!foldDone) return group;
    const done = sortTasks(ordered.filter((task) => (task.parentId ?? null) === parentId && task.status === 'done' && !group.some((item) => item.id === task.id)));
    return [...group, ...done];
  }
  const submitReorder = (group: Task[], parentId: string | null): Promise<unknown> => onReorder ? onReorder(withCompleted(group, parentId), parentId) : Promise.resolve();
  const submitNest = (task: Task, parentId: string | null, orderedIds: string[]) => {
    const extra = foldDone ? sortTasks(ordered.filter((item) => (item.parentId ?? null) === parentId && item.status === 'done' && !orderedIds.includes(item.id))).map((item) => item.id) : [];
    return onNest ? onNest(task, parentId, [...orderedIds, ...extra]) : Promise.resolve();
  };
  const actions = { ...resting, onReorder: onReorder ? submitReorder : undefined, onNest: onNest ? submitNest : undefined, dropParentId: projection?.parentId ?? '' };
  function finishDrag(event: DragEndEvent) {
    const overId = event.over ? String(event.over.id) : '';
    const activeId = String(event.active.id);
    setDrag(null);
    window.setTimeout(() => { skipClick.current = false; }, 400);
    if (!onReorder || !overId) return;
    if (hierarchical && onNest) {
      const next = projectTaskDrop(rows, activeId, overId, event.delta.x);
      const task = ordered.find((item) => item.id === activeId);
      if (!next || !task) return;
      const displayedParent = rows.find((row) => row.id === activeId)?.parentId ?? null;
      if (displayedParent !== next.parentId) {
        void submitNest(task, next.parentId, next.orderedIds).catch(() => undefined);
        onDragSettled?.();
        return;
      }
      const group = next.orderedIds.map((id) => ordered.find((item) => item.id === id)).filter((item): item is Task => Boolean(item));
      if (group.length === next.orderedIds.length) void submitReorder(group, next.parentId).catch(() => undefined);
      onDragSettled?.();
      return;
    }
    const groupId = String(event.active.data.current?.groupId ?? '');
    const next = reorderTaskGroup(openGroup(groupId), activeId, overId);
    if (next) {
      void submitReorder(next, groupId === 'root' || groupId === 'flat' ? null : next[0]?.parentId ?? null).catch(() => undefined);
      onDragSettled?.();
    }
  }
  const nestedTasks = (task: Task, nested: boolean) => {
    if (!hierarchical || nested) return null;
    const openChildren = openChildrenOf(task.id);
    const doneChildren = doneChildrenOf(task.id);
    if (!openChildren.length && !doneChildren.length) return null;
    return <div className="mt-2 space-y-2">{openChildren.length > 0 && list(openChildren, task.id, true)}{doneChildren.map((child, childIndex) => <StaticTask key={child.id} task={child} group={doneChildren} index={childIndex} nested actions={resting} />)}</div>;
  };
  const list = (items: Task[], groupId: string, nested = false): ReactNode => <SortableContext id={groupId} items={items.map((task) => task.id)} strategy={verticalListSortingStrategy}>{items.map((task, index) => {
    const children = !nested ? openChildrenOf(task.id) : [];
    return <SortableTask key={task.id} task={task} group={items} index={index} groupId={nested ? task.parentId ?? groupId : groupId} nested={nested} hasChildren={children.length > 0} actions={actions}>{nestedTasks(task, nested)}</SortableTask>;
  })}</SortableContext>;
  const activeTask = drag ? ordered.find((task) => task.id === drag.id) : undefined;
  const activeChildren = activeTask && activeRow && !activeRow.parentId ? ordered.filter((task) => task.parentId === activeTask.id) : [];
  const folded = foldedRoots.length > 0 && <details className="pt-2"><summary className="cursor-pointer text-sm text-muted-foreground">已完成 · {foldedRoots.length}</summary><div className="mt-2 space-y-2">{foldedRoots.map((task, index) => {
    const children = childrenOf(task.id);
    return <StaticTask key={task.id} task={task} group={foldedRoots} index={index} nested={false} actions={resting}>{hierarchical && children.length > 0 && <div className="mt-2 space-y-2">{children.map((child, childIndex) => <StaticTask key={child.id} task={child} group={children} index={childIndex} nested actions={resting} />)}</div>}</StaticTask>;
  })}</div></details>;
  const body = !visibleRoots.length && !foldedRoots.length ? <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p> : <>{visibleRoots.length > 0 && (onReorder ? list(visibleRoots, hierarchical ? 'root' : 'flat') : visibleRoots.map((task, index) => <StaticTask key={task.id} task={task} group={visibleRoots} index={index} nested={false} actions={actions}>{nestedTasks(task, false)}</StaticTask>))}{folded}</>;
  if (!onReorder) return <div className="space-y-2" data-testid="task-list">{body}</div>;
  return <DndContext sensors={sensors} collisionDetection={levelCollision} autoScroll={{ threshold: { x: 0, y: 0.15 } }} onDragStart={(event: DragStartEvent) => { skipClick.current = true; setDrag({ id: String(event.active.id), width: event.active.rect.current.initial?.width ?? 320, overId: String(event.active.id), x: 0 }); }} onDragMove={(event: DragMoveEvent) => setDrag((current) => current ? { ...current, x: event.delta.x } : current)} onDragOver={(event: DragOverEvent) => { const overId = event.over ? String(event.over.id) : ''; if (overId) setDrag((current) => current ? { ...current, overId } : current); }} onDragCancel={() => { setDrag(null); window.setTimeout(() => { skipClick.current = false; }, 400); }} onDragEnd={finishDrag}>
    <div className="space-y-2" data-testid="task-list">{body}</div>
    <DragOverlay className="task-drag-host" zIndex={80} dropAnimation={null}>{activeTask && <div className="task-drag-overlay" style={{ width: drag?.width, transform: `translateX(${shift}px)` }} aria-hidden><TaskArticle task={activeTask} nested={Boolean(activeRow?.parentId)} actions={actions} preview />{activeChildren.length > 0 && <div className="mt-2 space-y-2">{activeChildren.map((child) => <TaskArticle key={child.id} task={child} nested actions={actions} preview />)}</div>}</div>}</DragOverlay>
  </DndContext>;
}

function SortableTask({ task, group, index, groupId, nested, hasChildren = false, actions, children }: { task: Task; group: Task[]; index: number; groupId: string; nested: boolean; hasChildren?: boolean; actions: Actions & { skipClick: { current: boolean } }; children?: ReactNode }) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { groupId, hierarchical: actions.hierarchical, hasChildren }, disabled: Boolean(actions.busy), transition: { duration: 200, easing: 'ease' } });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="task-row-block" data-dragging={isDragging || undefined}><div className={isDragging ? 'invisible' : undefined}><TaskArticle ref={setActivatorNodeRef} task={task} group={group} index={index} nested={nested} actions={actions} listeners={listeners} />{children}</div></div>;
}

function StaticTask({ task, group, index, nested, actions, children }: { task: Task; group: Task[]; index: number; nested: boolean; actions: Actions & { skipClick: { current: boolean } }; children?: ReactNode }) {
  return <div><TaskArticle task={task} group={group} index={index} nested={nested} actions={actions} />{children}</div>;
}

const TaskArticle = forwardRef<HTMLElement, { task: Task; group?: Task[]; index?: number; nested?: boolean; actions: Actions & { skipClick: { current: boolean } }; listeners?: DraggableSyntheticListeners; preview?: boolean }>(function TaskArticle({ task, group = [], index = 0, nested = false, actions, listeners, preview }, ref) {
  const { topics, tags, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder, hierarchical, readonly, busy, selectedTaskId, textDirty, skipClick } = actions;
  const selected = !preview && selectedTaskId === task.id;
  const showHandle = Boolean(onReorder) || preview;
  const open = () => { if (!skipClick.current) onOpen(task.id); };
  const article = <article ref={ref} {...(preview ? {} : listeners)} data-testid={preview ? undefined : `task-row-${task.id}`} data-selected={selected || undefined} data-drop-parent={!preview && actions.dropParentId === task.id || undefined} onClick={(event) => { if (preview || skipClick.current) return; const target = event.target; if (!(target instanceof Element) || target.closest('button, a, select, label, input, [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]')) return; open(); }} className={cn('task-row group flex min-h-12 items-center gap-2 rounded-xl border border-transparent px-2.5 py-2', !preview && onReorder && 'cursor-grab', selected ? 'border-[var(--glass-border)] bg-[var(--glass-hover)] shadow-[inset_0_1px_0_var(--glass-highlight)]' : 'hover:bg-[var(--glass-subtle)]', nested && 'ml-7 border-l-[3px] border-l-border')}>
    {showHandle && <span className="task-drag-handle cursor-grab text-muted-foreground/60" title="拖动排序"><GripVertical className="size-4" /></span>}
    <input type="checkbox" className="task-checkbox size-[18px] shrink-0 accent-primary" checked={task.status === 'done'} disabled={preview || readonly || busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag} onChange={() => { void onToggle(task).catch(() => undefined); }} />
    <button type="button" aria-label={task.title} className="min-w-0 flex-1 py-0.5 text-left" disabled={preview} onClick={(event) => { event.stopPropagation(); open(); }}><span className={cn('block break-words text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span><span aria-hidden="true" className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">{task.priority !== 'none' && <span className="task-meta-pill">{priorities.find((value) => value.value === task.priority)?.label}</span>}{task.status !== 'todo' && task.status !== 'done' && <span className="task-meta-pill">{statuses.find((value) => value.value === task.status)?.label}</span>}{!hierarchical && <span className="task-place-chip">{task.topic?.name ?? '收集箱'}</span>}{task.tags?.map((tag) => <span key={tag.id} className="task-tag-chip" data-color={tag.color || 'violet'}>#{tag.name}</span>)}{!hierarchical && task.parentId && <span className="task-meta-pill">子任务</span>}</span></button>
    {task.dueDate && <time dateTime={task.dueDate} className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground min-[578px]:flex"><CalendarDays className="size-3.5" />{task.dueDate}</time>}
    {!preview && <TaskMenuButton />}
  </article>;
  if (preview) return article;
  const menu: TaskActionProps = { topics, tags, readonly, busy, textDirty, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder };
  return <TaskActions task={task} group={group} index={index} {...menu}>{article}</TaskActions>;
});
