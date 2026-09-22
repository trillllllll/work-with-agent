import { forwardRef, useRef, useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type DraggableSyntheticListeners } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, CalendarDays, FolderInput, GripVertical, MoreHorizontal, Trash2 } from 'lucide-react';
import type { Task, Topic } from '@/lib/api.js';
import { priorities, statuses } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { cn } from '@/lib/utils.js';
import { dragIndentOffset, projectTaskDrop, reorderTaskGroup, type OrderRow } from './task-order.js';

type Props = { tasks: Task[]; topics: Topic[]; onOpen: (id: string) => void; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>; onNest?: (task: Task, parentId: string | null, orderedIds: string[]) => Promise<unknown>; hierarchical?: boolean; readonly?: boolean; busy?: boolean; selectedTaskId?: string };
type Actions = Pick<Props, 'topics' | 'onOpen' | 'onToggle' | 'onMove' | 'onDelete' | 'onReorder' | 'hierarchical' | 'readonly' | 'busy' | 'selectedTaskId'> & { dropParentId?: string };

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

export function TaskList({ tasks, topics, onOpen, onToggle, onMove, onDelete, onReorder, onNest, hierarchical = false, readonly = false, busy, selectedTaskId }: Props) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const skipClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; width: number; overId: string; x: number } | null>(null);
  const ordered = hierarchical || onReorder ? sortTasks(tasks) : tasks;
  const roots = hierarchical ? ordered.filter((task) => !task.parentId || !ordered.some((parent) => parent.id === task.parentId)) : ordered;
  const rows: OrderRow[] = roots.flatMap((root) => {
    const children = ordered.filter((task) => task.parentId === root.id);
    return [{ id: root.id, parentId: null, hasChildren: children.length > 0 }, ...children.map((child): OrderRow => ({ id: child.id, parentId: root.id, hasChildren: false }))];
  });
  const projection = drag && hierarchical && onNest ? projectTaskDrop(rows, drag.id, drag.overId, drag.x) : null;
  const activeRow = drag ? rows.find((row) => row.id === drag.id) : undefined;
  const shift = projection && activeRow ? (projection.parentId && !activeRow.parentId ? dragIndentOffset : !projection.parentId && activeRow.parentId ? -dragIndentOffset : 0) : 0;
  const actions = { topics, onOpen, onToggle, onMove, onDelete, onReorder, hierarchical, readonly, busy, selectedTaskId, skipClick, dropParentId: projection?.parentId ?? '' };
  function siblings(groupId: string) {
    if (groupId === 'root' || groupId === 'flat') return roots;
    return ordered.filter((task) => task.parentId === groupId);
  }
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
        void onNest(task, next.parentId, next.orderedIds).catch(() => undefined);
        return;
      }
      const group = next.orderedIds.map((id) => ordered.find((item) => item.id === id)).filter((item): item is Task => Boolean(item));
      if (group.length === next.orderedIds.length) void onReorder(group, next.parentId).catch(() => undefined);
      return;
    }
    const groupId = String(event.active.data.current?.groupId ?? '');
    const next = reorderTaskGroup(siblings(groupId), activeId, overId);
    if (next) void onReorder(next, groupId === 'root' ? null : next[0]?.parentId ?? null).catch(() => undefined);
  }
  const list = (items: Task[], groupId: string, nested = false): ReactNode => <SortableContext id={groupId} items={items.map((task) => task.id)} strategy={verticalListSortingStrategy}>{items.map((task, index) => {
    const children = hierarchical && !nested ? ordered.filter((child) => child.parentId === task.id) : [];
    return <SortableTask key={task.id} task={task} group={items} index={index} groupId={nested ? task.parentId ?? groupId : groupId} nested={nested} hasChildren={children.length > 0} actions={actions}>{hierarchical && !nested && <div className="mt-2 space-y-2">{list(children, task.id, true)}</div>}</SortableTask>;
  })}</SortableContext>;
  const activeTask = drag ? ordered.find((task) => task.id === drag.id) : undefined;
  const activeChildren = activeTask && activeRow && !activeRow.parentId ? ordered.filter((task) => task.parentId === activeTask.id) : [];
  const body = !roots.length ? <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p> : onReorder ? list(roots, hierarchical ? 'root' : 'flat') : roots.map((task, index) => {
    const children = hierarchical ? ordered.filter((child) => child.parentId === task.id) : [];
    return <StaticTask key={task.id} task={task} group={roots} index={index} nested={false} actions={actions}>{hierarchical && <div className="mt-2 space-y-2">{children.map((child, childIndex) => <StaticTask key={child.id} task={child} group={children} index={childIndex} nested actions={actions} />)}</div>}</StaticTask>;
  });
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
  const { topics, onOpen, onToggle, onMove, onDelete, onReorder, hierarchical, readonly, busy, selectedTaskId, skipClick } = actions;
  const showHandle = Boolean(onReorder) || preview;
  return <article ref={ref} {...(preview ? {} : listeners)} data-testid={preview ? undefined : `task-row-${task.id}`} data-selected={!preview && selectedTaskId === task.id || undefined} data-drop-parent={!preview && actions.dropParentId === task.id || undefined} className={cn('task-row group flex min-h-12 items-center gap-2 rounded-xl border border-transparent px-2.5 py-2', !preview && onReorder && 'cursor-grab', selectedTaskId === task.id && !preview ? 'border-[var(--glass-border)] bg-[var(--glass-hover)] shadow-[inset_0_1px_0_var(--glass-highlight)]' : 'hover:bg-[var(--glass-subtle)]', nested && 'ml-7 border-l-[3px] border-l-border')}>
    {showHandle && <span className="task-drag-handle cursor-grab text-muted-foreground/60" title="拖动排序"><GripVertical className="size-4" /></span>}
    <input type="checkbox" className="task-checkbox size-[18px] shrink-0 accent-primary" checked={task.status === 'done'} disabled={preview || readonly || busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag} onChange={() => { void onToggle(task).catch(() => undefined); }} />
    <button type="button" aria-label={task.title} className="min-w-0 flex-1 py-0.5 text-left" disabled={preview} onClick={() => { if (skipClick.current) return; onOpen(task.id); }}><span className={cn('block break-words text-sm font-medium', task.status === 'done' && 'text-muted-foreground line-through')}>{task.title}</span><span aria-hidden="true" className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">{task.priority !== 'none' && <span className="task-meta-pill">{priorities.find((value) => value.value === task.priority)?.label}</span>}{task.status !== 'todo' && task.status !== 'done' && <span className="task-meta-pill">{statuses.find((value) => value.value === task.status)?.label}</span>}<span className="task-place-chip">{task.topic?.name ?? '收集箱'}</span>{task.tags?.map((tag) => <span key={tag.id} className="task-tag-chip" data-color={tag.color || 'violet'}>#{tag.name}</span>)}{!hierarchical && task.parentId && <span className="task-meta-pill">子任务</span>}</span></button>
    {task.dueDate && <time className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex"><CalendarDays className="size-3.5" />{task.dueDate}</time>}
    {!readonly && !preview && <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`任务操作：${task.title}`} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuSub><DropdownMenuSubTrigger><FolderInput />移动到</DropdownMenuSubTrigger><DropdownMenuSubContent>
          <DropdownMenuItem disabled={!task.topicId} onSelect={() => { void onMove(task, null).catch(() => undefined); }}>收集箱</DropdownMenuItem>
          {topics.map((topic) => <DropdownMenuItem key={topic.id} disabled={task.topicId === topic.id} onSelect={() => { void onMove(task, topic.id).catch(() => undefined); }}>{topic.name}</DropdownMenuItem>)}
        </DropdownMenuSubContent></DropdownMenuSub>
        {onReorder && <><DropdownMenuItem disabled={busy || index === 0} aria-label={`上移任务：${task.title}`} onSelect={() => { const next = reorderTaskGroup(group, task.id, group[index - 1]?.id ?? ''); if (next) void onReorder(next, task.parentId ?? null).catch(() => undefined); }}><ArrowUp />上移</DropdownMenuItem><DropdownMenuItem disabled={busy || index === group.length - 1} aria-label={`下移任务：${task.title}`} onSelect={() => { const next = reorderTaskGroup(group, task.id, group[index + 1]?.id ?? ''); if (next) void onReorder(next, task.parentId ?? null).catch(() => undefined); }}><ArrowDown />下移</DropdownMenuItem></>}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" aria-label={`删除任务：${task.title}`} onSelect={() => onDelete(task)}><Trash2 />移入回收站</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>}
  </article>;
});
