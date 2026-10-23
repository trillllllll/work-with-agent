import { forwardRef, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type DraggableSyntheticListeners } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarDays, Clock, GripVertical } from 'lucide-react';
import type { Tag, Task, Topic } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import type { TaskDraft } from '@/lib/todo.js';
import { scheduleLabel } from '@/lib/schedule.js';
import { cn } from '@/lib/utils.js';
import { completeSiblingIds, dragIndentOffset, projectTaskDrop, reorderTaskGroup, type OrderRow } from './task-order.js';
import { useTaskCollapse } from './task-collapse.js';
import { TaskActions, TaskMenuButton, type TaskActionProps } from './TaskActionsMenu.js';

type Props = { assistantSelectedIds?: string[]; onAssistantSelect?: (id: string) => void; tasks: Task[]; topics: Topic[]; tags: Tag[]; onOpen: (id: string) => void; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>; onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>; onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>; onNest?: (task: Task, parentId: string | null, orderedIds: string[]) => Promise<unknown>; onDragSettled?: () => void; hierarchical?: boolean; foldDone?: boolean; readonly?: boolean; busy?: boolean; selectedTaskId?: string; textDirty?: boolean };
type Actions = Pick<Props, 'assistantSelectedIds' | 'onAssistantSelect' | 'topics' | 'tags' | 'onOpen' | 'onToggle' | 'onMove' | 'onDelete' | 'onSave' | 'onCreate' | 'onReorder' | 'hierarchical' | 'readonly' | 'busy' | 'selectedTaskId' | 'textDirty'> & { dropParentId?: string; onToggleChildren?: (parentId: string) => void };
type SortScope = 'tree' | 'siblings';
type TaskDragData = { groupId: string; hierarchical: boolean; hasChildren: boolean; sortScope: SortScope };
type DragState = { id: string; width: number; overId: string; x: number; sortScope: SortScope };

const levelCollision: CollisionDetection = (args) => {
  const data = args.active.data.current as Partial<TaskDragData> | undefined;
  const containers = data?.sortScope === 'siblings'
    ? args.droppableContainers.filter((container) => container.data.current?.sortScope === 'siblings' && container.data.current?.groupId === data.groupId)
    : args.droppableContainers.filter((container) => {
      if (container.data.current?.sortScope !== 'tree') return false;
      if (!data?.hierarchical || data.hasChildren) return container.data.current?.groupId === data?.groupId;
      return Boolean(container.data.current?.hierarchical);
    });
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

export function TaskList({ assistantSelectedIds, onAssistantSelect, tasks, topics, tags, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder, onNest, onDragSettled, hierarchical = false, foldDone = false, readonly = false, busy, selectedTaskId, textDirty }: Props) {
  const { t } = useTranslation('tasks');
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const skipClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const { collapsed, toggle: toggleChildren, expand: expandChildren } = useTaskCollapse();
  const collapsedSet = new Set(collapsed);
  const canSort = Boolean(onReorder) && !readonly;
  const ordered = hierarchical || onReorder ? sortTasks(tasks) : tasks;
  const roots = hierarchical ? ordered.filter((task) => !task.parentId || !ordered.some((parent) => parent.id === task.parentId)) : ordered;
  const visibleRoots = foldDone ? roots.filter((task) => task.status !== 'done') : roots;
  const foldedRoots = foldDone ? roots.filter((task) => task.status === 'done') : [];
  const childrenOf = (parentId: string) => ordered.filter((task) => task.parentId === parentId);
  const rows: OrderRow[] = visibleRoots.flatMap((root) => {
    const children = childrenOf(root.id);
    const hasChildren = children.length > 0;
    if (collapsedSet.has(root.id)) return [{ id: root.id, parentId: null, hasChildren }];
    return [{ id: root.id, parentId: null, hasChildren }, ...children.map((child): OrderRow => ({ id: child.id, parentId: root.id, hasChildren: childrenOf(child.id).length > 0 }))];
  });
  const projection = drag && drag.sortScope === 'tree' && hierarchical && onNest ? projectTaskDrop(rows, drag.id, drag.overId, drag.x) : null;
  const activeRow = drag ? rows.find((row) => row.id === drag.id) : undefined;
  const activeNested = drag?.sortScope === 'siblings' || Boolean(activeRow?.parentId);
  const shift = drag?.sortScope === 'siblings' || !projection || !activeRow ? 0 : projection.parentId && !activeRow.parentId ? dragIndentOffset : !projection.parentId && activeRow.parentId ? -dragIndentOffset : 0;
  const createChild = hierarchical ? async (input: { title: string; topicId: string | null; parentId: string | null }) => {
    const result = await onCreate(input);
    if (input.parentId) expandChildren(input.parentId);
    return result;
  } : onCreate;
  const saveTask = hierarchical ? async (task: Task, patch: Partial<TaskDraft>) => {
    const result = await onSave(task, patch);
    if (result !== undefined && patch.parentId && patch.parentId !== task.id) expandChildren(patch.parentId);
    return result;
  } : onSave;
  const resting = { assistantSelectedIds, onAssistantSelect, topics, tags, onOpen, onToggle, onMove, onDelete, onSave: saveTask, onCreate: createChild, hierarchical, readonly, busy, selectedTaskId, textDirty, skipClick, dropParentId: '', onToggleChildren: toggleChildren };
  function openGroup(groupId: string) {
    if (groupId === 'root' || groupId === 'flat') return visibleRoots;
    return childrenOf(groupId);
  }
  function completeScope(proposedIds: string[], parentId: string | null) {
    const siblingIds = ordered.filter((task) => (task.parentId ?? null) === parentId).map((task) => task.id);
    return completeSiblingIds(proposedIds, siblingIds);
  }
  function tasksInOrder(ids: string[], preferred: Task[]) {
    const byId = new Map<string, Task>([...ordered.map((task) => [task.id, task] as const), ...preferred.map((task) => [task.id, task] as const)]);
    return ids.map((id) => byId.get(id)).filter((task): task is Task => Boolean(task));
  }
  const submitReorder = (group: Task[], parentId: string | null): Promise<unknown> => {
    if (!onReorder) return Promise.resolve();
    const ids = completeScope(group.map((task) => task.id), parentId);
    return onReorder(tasksInOrder(ids, group), parentId);
  };
  const submitNest = (task: Task, parentId: string | null, orderedIds: string[]) => onNest ? onNest(task, parentId, completeScope(orderedIds, parentId)) : Promise.resolve();
  const actions = { ...resting, onReorder: onReorder ? submitReorder : undefined, onNest: onNest ? submitNest : undefined, dropParentId: projection?.parentId ?? '' };
  function finishDrag(event: DragEndEvent) {
    const overId = event.over ? String(event.over.id) : '';
    const activeId = String(event.active.id);
    const activeData = event.active.data.current as Partial<TaskDragData> | undefined;
    setDrag(null);
    window.setTimeout(() => { skipClick.current = false; }, 400);
    if (!canSort || busy || !overId) return;
    if (activeData?.sortScope === 'siblings') {
      const group = childrenOf(String(activeData.groupId ?? ''));
      if (!group.some((item) => item.id === activeId) || !group.some((item) => item.id === overId)) return;
      const next = reorderTaskGroup(group, activeId, overId);
      if (!next) return;
      void submitReorder(next, String(activeData.groupId)).catch(() => undefined);
      onDragSettled?.();
      return;
    }
    if (hierarchical && onNest) {
      const next = projectTaskDrop(rows, activeId, overId, event.delta.x);
      const task = ordered.find((item) => item.id === activeId);
      if (!next || !task) return;
      const displayedParent = rows.find((row) => row.id === activeId)?.parentId ?? null;
      if (displayedParent !== next.parentId) {
        if (next.parentId) expandChildren(next.parentId);
        void submitNest(task, next.parentId, next.orderedIds).catch(() => undefined);
        onDragSettled?.();
        return;
      }
      const group = next.orderedIds.map((id) => ordered.find((item) => item.id === id)).filter((item): item is Task => Boolean(item));
      if (group.length === next.orderedIds.length) void submitReorder(group, next.parentId).catch(() => undefined);
      onDragSettled?.();
      return;
    }
    const groupId = String(activeData?.groupId ?? '');
    const next = reorderTaskGroup(openGroup(groupId), activeId, overId);
    if (next) {
      void submitReorder(next, groupId === 'root' || groupId === 'flat' ? null : next[0]?.parentId ?? null).catch(() => undefined);
      onDragSettled?.();
    }
  }
  const renderChildren = (parent: Task, scope: SortScope) => {
    if (!hierarchical || collapsedSet.has(parent.id)) return null;
    const children = childrenOf(parent.id);
    if (!children.length) return null;
    const rowsForChildren = canSort
      ? <SortableContext id={`${scope}:${parent.id}`} items={children.map((task) => task.id)} strategy={verticalListSortingStrategy}>{children.map((child, index) => <SortableTask key={child.id} task={child} group={children} index={index} groupId={parent.id} sortScope={scope} nested hasChildren={childrenOf(child.id).length > 0} actions={actions} />)}</SortableContext>
      : children.map((child, index) => <StaticTask key={child.id} task={child} group={children} index={index} nested actions={resting} />);
    return <div className="task-rows task-children border-t border-[var(--glass-divider)]">{rowsForChildren}</div>;
  };
  const list = (items: Task[], groupId: string): ReactNode => <SortableContext id={groupId} items={items.map((task) => task.id)} strategy={verticalListSortingStrategy}>{items.map((task, index) => {
    const children = childrenOf(task.id);
    return <SortableTask key={task.id} task={task} group={items} index={index} groupId={groupId} sortScope="tree" nested={false} hasChildren={children.length > 0} childrenCollapsed={collapsedSet.has(task.id)} actions={actions}>{renderChildren(task, 'tree')}</SortableTask>;
  })}</SortableContext>;
  const activeTask = drag ? ordered.find((task) => task.id === drag.id) : undefined;
  const activeChildren = activeTask && drag?.sortScope !== 'siblings' && activeRow && !activeRow.parentId && !collapsedSet.has(activeTask.id) ? childrenOf(activeTask.id) : [];
  const folded = foldedRoots.length > 0 && <details className="disclosure mt-1 border-t border-[var(--glass-divider)] pt-1"><summary className="task-fold">{t('taskList.completedCount', { count: foldedRoots.length })}</summary><div className="task-rows">{foldedRoots.map((task, index) => {
    const children = childrenOf(task.id);
    return <StaticTask key={task.id} task={task} group={foldedRoots} index={index} nested={false} hasChildren={children.length > 0} childrenCollapsed={collapsedSet.has(task.id)} actions={resting}>{renderChildren(task, 'siblings')}</StaticTask>;
  })}</div></details>;
  const quiet = { ...actions, onReorder: undefined, onNest: undefined };
  const body = !visibleRoots.length && !foldedRoots.length ? <p className="py-12 text-center text-sm text-muted-foreground">{t('taskList.empty')}</p> : <>{visibleRoots.length > 0 && (canSort ? list(visibleRoots, hierarchical ? 'root' : 'flat') : visibleRoots.map((task, index) => <StaticTask key={task.id} task={task} group={visibleRoots} index={index} nested={false} hasChildren={childrenOf(task.id).length > 0} childrenCollapsed={collapsedSet.has(task.id)} actions={quiet}>{renderChildren(task, 'tree')}</StaticTask>))}{folded}</>;
  if (!canSort) return <div className="task-rows" data-testid="task-list">{body}</div>;
  return <DndContext sensors={sensors} collisionDetection={levelCollision} autoScroll={{ threshold: { x: 0, y: 0.15 } }} onDragStart={(event: DragStartEvent) => { skipClick.current = true; const data = event.active.data.current as Partial<TaskDragData> | undefined; setDrag({ id: String(event.active.id), width: event.active.rect.current.initial?.width ?? 320, overId: String(event.active.id), x: 0, sortScope: data?.sortScope === 'siblings' ? 'siblings' : 'tree' }); }} onDragMove={(event: DragMoveEvent) => setDrag((current) => current ? { ...current, x: event.delta.x } : current)} onDragOver={(event: DragOverEvent) => { const overId = event.over ? String(event.over.id) : ''; if (overId) setDrag((current) => current ? { ...current, overId } : current); }} onDragCancel={() => { setDrag(null); window.setTimeout(() => { skipClick.current = false; }, 400); }} onDragEnd={finishDrag}>
    <div className="task-rows" data-testid="task-list">{body}</div>
    <DragOverlay className="task-drag-host" zIndex={80} dropAnimation={null}>{activeTask && <div className="task-drag-overlay" style={{ width: drag?.width, transform: `translateX(${shift}px)` }} aria-hidden><TaskArticle task={activeTask} nested={activeNested} actions={actions} preview />{activeChildren.length > 0 && <div className="task-rows task-children border-t border-[var(--glass-divider)]">{activeChildren.map((child) => <TaskArticle key={child.id} task={child} nested actions={actions} preview />)}</div>}</div>}</DragOverlay>
  </DndContext>;
}

function SortableTask({ task, group, index, groupId, sortScope, nested, hasChildren = false, childrenCollapsed = false, actions, children }: { task: Task; group: Task[]; index: number; groupId: string; sortScope: SortScope; nested: boolean; hasChildren?: boolean; childrenCollapsed?: boolean; actions: Actions & { skipClick: { current: boolean } }; children?: ReactNode }) {
  const data: TaskDragData = { groupId, hierarchical: Boolean(actions.hierarchical), hasChildren, sortScope };
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data, disabled: Boolean(actions.busy) || Boolean(actions.readonly), transition: { duration: 200, easing: 'ease' } });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="task-row-block" data-dragging={isDragging || undefined}><div className={isDragging ? 'invisible' : undefined}><TaskArticle ref={setActivatorNodeRef} task={task} group={group} index={index} nested={nested} hasChildren={hasChildren} childrenCollapsed={childrenCollapsed} actions={actions} listeners={listeners} />{children}</div></div>;
}

function StaticTask({ task, group, index, nested, hasChildren = false, childrenCollapsed = false, actions, children }: { task: Task; group: Task[]; index: number; nested: boolean; hasChildren?: boolean; childrenCollapsed?: boolean; actions: Actions & { skipClick: { current: boolean } }; children?: ReactNode }) {
  return <div><TaskArticle task={task} group={group} index={index} nested={nested} hasChildren={hasChildren} childrenCollapsed={childrenCollapsed} actions={actions} />{children}</div>;
}

const TaskArticle = forwardRef<HTMLElement, { task: Task; group?: Task[]; index?: number; nested?: boolean; hasChildren?: boolean; childrenCollapsed?: boolean; actions: Actions & { skipClick: { current: boolean } }; listeners?: DraggableSyntheticListeners; preview?: boolean }>(function TaskArticle({ task, group = [], index = 0, nested = false, hasChildren = false, childrenCollapsed = false, actions, listeners, preview }, ref) {
  const { t } = useTranslation('tasks');
  const { topics, tags, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder, hierarchical, readonly, busy, selectedTaskId, textDirty, skipClick } = actions;
  const selected = !preview && selectedTaskId === task.id;
  const showHandle = Boolean(onReorder) || preview;
  const open = () => { if (!skipClick.current) onOpen(task.id); };
  const article = <article ref={ref} {...(preview ? {} : listeners)} data-testid={preview ? undefined : `task-row-${task.id}`} data-selected={selected || undefined} data-drop-parent={!preview && actions.dropParentId === task.id || undefined} onClick={(event) => { if (preview || skipClick.current) return; const target = event.target; if (!(target instanceof Element) || target.closest('button, a, select, label, input, [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]')) return; open(); }} className={cn('task-row group flex min-h-11 items-center gap-2 border border-transparent px-2.5 py-1.5', !preview && onReorder && 'cursor-grab', selected ? 'border-[var(--glass-border-soft)] bg-[var(--glass-hover)]' : 'hover:bg-[var(--glass-subtle)]')}>
    {!preview && actions.onAssistantSelect && <button type="button" className={cn('shrink-0 rounded px-1 py-1 text-[10px] text-muted-foreground hover:bg-muted', actions.assistantSelectedIds?.includes(task.id) && 'bg-primary/10 text-primary')} aria-label={t('taskList.selectAi', { title: task.title })} aria-pressed={actions.assistantSelectedIds?.includes(task.id) ?? false} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag} onClick={(event) => { event.stopPropagation(); actions.onAssistantSelect?.(task.id); }}>AI</button>}
    {showHandle && <span className="task-drag-handle cursor-grab text-muted-foreground/60" title={t('taskList.drag')}><GripVertical className="size-4" /></span>}
    {hierarchical && !nested && (hasChildren && !preview
      ? <button type="button" className="task-expand" aria-label={t(childrenCollapsed ? 'taskList.expandSubtasks' : 'taskList.collapseSubtasks', { title: task.title })} aria-expanded={!childrenCollapsed} onClick={(event) => { event.stopPropagation(); actions.onToggleChildren?.(task.id); }} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag}><span className="disclosure-chevron" data-open={!childrenCollapsed || undefined} aria-hidden="true" /></button>
      : <span className="w-5 shrink-0" aria-hidden="true" />)}
    <input type="checkbox" className="task-checkbox size-[18px] shrink-0 accent-primary" checked={task.status === 'done'} disabled={preview || readonly || busy} aria-label={t(task.status === 'done' ? 'shared.reopenTask' : 'shared.completeTask', { title: task.title })} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag} onChange={() => { void onToggle(task).catch(() => undefined); }} />
    <button type="button" aria-label={task.title} className="min-w-0 flex-1 py-0.5 text-left" disabled={preview} onClick={(event) => { event.stopPropagation(); open(); }}><span className={cn('block break-words text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span><span aria-hidden="true" className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">{task.priority !== 'none' && <span className="task-meta-pill">{priorities.find((value) => value.value === task.priority)?.label}</span>}{task.status !== 'todo' && task.status !== 'done' && <span className="task-meta-pill">{statuses.find((value) => value.value === task.status)?.label}</span>}{!hierarchical && <span className="task-place-chip">{task.topic?.name ?? t('shared.inbox')}</span>}{task.tags?.map((tag) => <span key={tag.id} className="task-tag-chip" data-color={tag.color || 'violet'}>#{tag.name}</span>)}{!hierarchical && task.parentId && <span className="task-meta-pill">{t('shared.subtask')}</span>}</span></button>
    {task.scheduledStart && <span className="hidden max-w-[45%] shrink-0 items-center gap-1 text-xs text-muted-foreground min-[578px]:flex"><Clock className="size-3.5" strokeWidth={1.75} /><time className="truncate" dateTime={task.scheduledStart} title={scheduleLabel(task)}><span className="task-schedule-full">{scheduleLabel(task)}</span><span className="task-schedule-time">{task.scheduledStart.slice(11, 16)}</span></time></span>}
    {task.dueDate && !task.scheduledStart && <time dateTime={task.dueDate} className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground min-[578px]:flex"><CalendarDays className="size-3.5" />{task.dueDate}</time>}
    {!preview && <TaskMenuButton />}
  </article>;
  if (preview) return article;
  const menu: TaskActionProps = { topics, tags, readonly, busy, textDirty, onOpen, onToggle, onMove, onDelete, onSave, onCreate, onReorder };
  return <TaskActions task={task} group={group} index={index} {...menu}>{article}</TaskActions>;
});
