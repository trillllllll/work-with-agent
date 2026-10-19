import { usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DragOverEvent } from '@dnd-kit/core';
import type { Tag, Task, Topic } from '@/lib/api.js';
import { useLocalDate, useTasks } from '@/hooks/useTodo.js';
import { addDays, addMinutes, applyDrop, eachDate, formatTime, isOverdue, layoutTimed, localDateTime, minutesBetween, minutesOf, occursOn, rangeOf, resizeSchedule, scheduleDateKey, scheduleLabel, shiftMonth, type SchedulePatch, type TimedBlock } from '@/lib/schedule.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { ScheduleFields, scheduleError, type ScheduleValue } from '@/components/tasks/ScheduleFields.js';
import { isCompositionKey } from '@/lib/todo.js';
import type { PlanTimeBand } from '@/lib/api.js';
import { isoWeekday, planTimeline, planTimelineMinWidth, resolveTimeBandSegments } from '@/lib/plan-time-bands.js';
import { TimeBandLayer } from './TimeBandLayer.js';
import { TimeBandControls } from './TimeBandDialog.js';
import { usePlanTimeBands } from './usePlanTimeBands.js';
import { ChevronLeft, ChevronRight, PanelRight, X } from 'lucide-react';
import { groupTimedBlocks } from '@/lib/plan-layout.js';

type Mode = 'day' | 'week' | 'month';
function readPlanMode(): Mode {
  const stored = localStorage.getItem('todo.plan.mode');
  return stored === 'day' || stored === 'week' || stored === 'month' ? stored : 'week';
}
type Props = {
  topics: Topic[]; tags: Tag[];
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<Task | undefined> | void;
  onSave: (task: Task, patch: SchedulePatch) => Promise<Task | undefined> | void;
  onCreate: (input: { title: string; topicId: string | null; parentId: null } & ScheduleValue) => Promise<unknown>;
  onDelete: (task: Task) => void; busy: boolean;
};
const hourHeight = 56;
const timelineHeight = hourHeight * 24;
function priorityColor(priority: Task['priority']) {
  return priority === 'high' ? 'var(--destructive)' : priority === 'medium' ? 'var(--warning)' : priority === 'low' ? 'var(--primary)' : 'var(--muted-foreground)';
}
function dateLabel(value: string, options: Intl.DateTimeFormatOptions) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(year, month - 1, day));
}
function rangeLabel(mode: Mode, anchor: string, range: [string, string]) {
  return mode === 'day' ? `${dateLabel(anchor, { month: 'numeric', day: 'numeric' })} ${dateLabel(anchor, { weekday: 'short' })}` : mode === 'week' ? `${range[0]} — ${range[1]}` : dateLabel(anchor, { year: 'numeric', month: 'long' });
}
function DropTarget({ id, className, style, children }: { id: string; className?: string; style?: CSSProperties; children?: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} data-drop-id={id} style={style} className={cn(className, isOver && 'bg-primary/10 outline-2 outline-primary/40')}>{children}</div>;
}
function DragTask({ task, instance, busy, offset = 0, className, style, children }: { task: Task; instance: string; busy: boolean; offset?: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${task.id}:${instance}`, data: { task, offset }, disabled: busy });
  return <div ref={setNodeRef} style={{ ...style, touchAction: 'manipulation' }} className={cn(className, isDragging && 'opacity-40')} {...listeners} {...attributes}>{children}</div>;
}
function ResizeHandle({ task, edge, busy, onOpen }: { task: Task; onOpen: Props['onOpen']; edge: 'start' | 'end'; busy: boolean }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `${task.id}:resize:${edge}`, data: { task, edge }, disabled: busy });
  return <button type="button" ref={setNodeRef} {...attributes} {...listeners} onPointerDown={(event) => { event.stopPropagation(); listeners?.onPointerDown?.(event); }} aria-label={`${edge === 'start' ? '调整开始' : '调整结束'}：${task.title}`} title="拖动调整时间；也可在任务详情中编辑" style={{ touchAction: 'none' }} onClick={(event) => { event.stopPropagation(); onOpen(task.id); }} className={cn('absolute inset-x-1 z-10 h-2 cursor-ns-resize rounded focus-visible:bg-primary/30', edge === 'start' ? 'top-0' : 'bottom-0')} />;
}
function Check({ task, busy, onToggle }: { task: Task; busy: boolean; onToggle: Props['onToggle'] }) {
  return <input type="checkbox" className="task-checkbox size-4 shrink-0 accent-primary" checked={task.status === 'done'} disabled={busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={() => { void Promise.resolve(onToggle(task)).catch(() => undefined); }} />;
}
function TimedTask({ block, dateKey, busy, onOpen, onToggle }: { block: TimedBlock; dateKey: string; busy: boolean; onOpen: Props['onOpen']; onToggle: Props['onToggle'] }) {
  const task = block.task;
  const height = block.point ? 28 : Math.max(24, (block.endMin - block.startMin) / 60 * hourHeight - 2);
  const top = Math.min(block.startMin / 60 * hourHeight, timelineHeight - height);
  const offset = minutesBetween(task.scheduledStart!, addMinutes(`${dateKey}T00:00`, block.startMin));
  return <DragTask task={task} instance={dateKey} offset={offset} busy={busy} className="pointer-events-auto absolute z-[2]" style={{ top, height, left: `calc(${block.lane / block.laneCount * 100}% + 2px)`, width: `calc(${100 / block.laneCount}% - 4px)` }}>
    <article data-testid="task-block" data-task-id={task.id} data-date={dateKey} data-point={block.point} title={`${task.title} · ${scheduleLabel(task)}`} className={cn('plan-timed-task relative h-full overflow-hidden rounded-md border px-1.5 text-xs leading-tight', block.point ? 'flex items-center border-dashed' : 'pt-2 pb-1', task.status === 'done' && 'opacity-55 line-through')} style={{ borderLeftWidth: block.point ? 1 : 2, borderLeftColor: priorityColor(task.priority) }}>
      {!block.point && block.startsHere && <ResizeHandle task={task} edge="start" busy={busy} onOpen={onOpen} />}
      <div className="flex min-w-0 items-start gap-1">
        <Check task={task} busy={busy} onToggle={onToggle} />
        <button type="button" className="min-w-0 flex-1 text-left" aria-label={`打开任务：${task.title}`} onClick={() => onOpen(task.id)}>
          <span className="plan-task-title block truncate">{block.point && <span>● {formatTime(task.scheduledStart!)} </span>}{!block.startsHere && '↳ '}{task.title}</span>
          {height >= 44 && <span className="block truncate text-[10px] text-muted-foreground tabular-nums">{block.startsHere ? formatTime(task.scheduledStart!) : '00:00'}—{block.endsHere ? formatTime(task.scheduledEnd!) : '24:00'}</span>}
        </button>
      </div>
      {!block.point && block.endsHere && <ResizeHandle task={task} edge="end" busy={busy} onOpen={onOpen} />}
    </article>
  </DragTask>;
}
function NowLine({ dateKey, today }: { dateKey: string; today: string }) {
  const [now, setNow] = useState(localDateTime);
  useEffect(() => { const timer = window.setInterval(() => setNow(localDateTime()), 30000); return () => window.clearInterval(timer); }, []);
  return dateKey === today ? <div className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-destructive" style={{ top: minutesOf(now) / 60 * hourHeight }} /> : null;
}
function OverlapGroup({ group, day, onOpen }: { group: TimedBlock[]; day: string; onOpen: (trigger: HTMLButtonElement) => void }) {
  const start = group[0].startMin;
  const end = Math.max(...group.map((block) => Math.max(block.endMin, block.startMin + 30)));
  const height = Math.max(24, Math.min(44, (end - start) / 60 * hourHeight - 2));
  const time = formatTime(addMinutes(`${day}T00:00`, start));
  return <button type="button" data-testid="plan-overlap" data-date={day} aria-label={`${day} ${time} ${group.length} 项重叠任务`} title={`${time} · ${group.map((block) => block.task.title).join('、')}`} className="plan-overlap pointer-events-auto absolute inset-x-1 z-[3] overflow-hidden rounded-md border border-dashed px-2 text-left text-xs" style={{ top: Math.min(start / 60 * hourHeight, timelineHeight - height), height }} onClick={(event) => onOpen(event.currentTarget)}>{height >= 38 && <span className="block text-[10px] tabular-nums text-muted-foreground">{time}</span>}<span className="block truncate">{group.length} 项重叠</span></button>;
}
const allDayPreviewLimit = 2;
function Timeline({ days, tasks, today, busy, bands, allDayOpen, activeTaskId, onAllDayOpen, onOpen, onToggle, onCreate }: { days: string[]; tasks: Task[]; today: string; busy: boolean; bands: readonly PlanTimeBand[]; allDayOpen: boolean | null; activeTaskId?: string; onAllDayOpen: (open: boolean) => void; onOpen: Props['onOpen']; onToggle: Props['onToggle']; onCreate: (value: ScheduleValue) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const calendar = useRef<HTMLDivElement>(null);
  const overlapOpener = useRef<HTMLButtonElement | null>(null);
  const openingTask = useRef(false);
  const [overlap, setOverlap] = useState<{ day: string; taskIds: string[] } | null>(null);
  const overlapTasks = overlap ? tasks.filter((task) => overlap.taskIds.includes(task.id)) : [];
  const week = days.length === 7;
  const columns = `${planTimeline.hourGutter}px repeat(${days.length}, minmax(0, 1fr))`;
  const bandDays = new Set(days.filter((day) => resolveTimeBandSegments(bands, isoWeekday(day)).length > 0));
  const allDayByDay = new Map(days.map((day) => [day, tasks.filter((task) => !task.scheduledStart && task.dueDate === day)]));
  const hasAllDay = [...allDayByDay.values()].some((items) => items.length > 0);
  const allDayExpanded = allDayOpen ?? ![...allDayByDay.values()].some((items) => items.length > allDayPreviewLimit);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, minutesOf(localDateTime()) / 60 * hourHeight - 120); }, [days[0], days.length]);
  return <><div ref={calendar} role="region" aria-label="规划时间网格" tabIndex={-1} data-testid="calendar-horizontal-scroll" data-plan-span={days.length > 1 ? 'week' : 'day'} className={cn('plan-calendar min-w-0 overflow-x-auto', days.length > 1 && 'plan-calendar-week')}><div style={{ minWidth: planTimelineMinWidth(days.length) }}>
    <div className="grid" style={{ gridTemplateColumns: columns }}>
      <div className="min-h-0 self-start p-1 text-center text-[10px] text-muted-foreground">{hasAllDay ? <button type="button" aria-expanded={allDayExpanded} aria-label={allDayExpanded ? '收起全天任务' : '展开全天任务'} className="flex w-full flex-col items-center gap-0.5 rounded py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" onClick={() => onAllDayOpen(!allDayExpanded)}><span className="disclosure-chevron" data-open={allDayExpanded || undefined} aria-hidden="true" />全天</button> : '全天'}</div>
      {days.map((day) => {
        const items = allDayByDay.get(day) ?? [];
        const visible = allDayExpanded ? items : items.slice(0, allDayPreviewLimit);
        const hidden = items.length - visible.length;
        return <div key={day} className="min-h-0 min-w-0 border-l border-[var(--glass-divider)]">
          <DropTarget id={`dayhead:${day}`} className="plan-day-heading p-1 text-center text-xs"><button type="button" onClick={() => onCreate({ dueDate: day, scheduledStart: null, scheduledEnd: null })} aria-label={`在${day}添加全天任务`} className="flex w-full items-center justify-center gap-2 rounded py-2 hover:bg-muted"><span className="text-muted-foreground">{dateLabel(day, { weekday: 'short' })}</span><span className={cn('inline-grid size-7 place-items-center rounded-full text-sm', day === today && 'bg-primary text-primary-foreground')}>{Number(day.slice(8))}</span></button></DropTarget>
          <DropTarget id={`allday:${day}`} className={cn('min-h-12 space-y-1 p-1', allDayExpanded && 'max-h-36 overflow-y-auto')}>
            {visible.map((task) => <DragTask key={task.id} task={task} instance={`all:${day}`} busy={busy}><div className={cn('flex items-center gap-1 rounded bg-muted/50 px-1 py-1 text-xs', task.status === 'done' && 'opacity-55 line-through')}><Check task={task} busy={busy} onToggle={onToggle} /><button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(task.id)}>{task.title}</button></div></DragTask>)}
            {hidden > 0 && <button type="button" className="task-fold min-w-0" onClick={() => onAllDayOpen(true)}><span className="min-w-0 truncate">还有 {hidden} 个</span></button>}
          </DropTarget>
        </div>;
      })}
    </div>
    <div ref={scroller} data-testid="timeline-scroll" className="max-h-[65vh] overflow-y-auto border-t border-[var(--glass-divider)]">
      <div className="grid" style={{ gridTemplateColumns: columns, height: timelineHeight }}>
        <div>{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="border-b border-[var(--glass-divider)] pr-1 text-right text-[10px] tabular-nums text-muted-foreground" style={{ height: hourHeight }}>{String(hour).padStart(2, '0')}:00</div>)}</div>
        {days.map((day) => {
          const banded = bandDays.has(day);
          return <div key={day} data-testid="time-band-day" data-date={day} data-band-rail={banded ? 'true' : 'false'} className="relative isolate border-l border-[var(--glass-divider)]">
            <TimeBandLayer bands={bands} dateKey={day} />
            {banded && !week && <div data-testid="time-band-rail" className="pointer-events-none absolute inset-y-0 z-[1] border-r border-[var(--glass-divider)]" style={{ width: 'var(--plan-band-rail, 112px)' }} />}
            {Array.from({ length: 48 }, (_, index) => {
              const start = addMinutes(`${day}T00:00`, index * 30);
              const id = `slot:${day}:${start.slice(11, 13)}:${start.slice(14, 16)}`;
              return <DropTarget key={id} id={id} className="absolute inset-x-0 z-[1]" style={{ top: index * hourHeight / 2, height: hourHeight / 2 }}><button type="button" disabled={busy} aria-label={`在${start.replace('T', ' ')}添加任务`} className="h-full w-full bg-transparent hover:bg-primary/5 focus-visible:bg-primary/10" onClick={() => onCreate({ dueDate: day, scheduledStart: start, scheduledEnd: addMinutes(start, 60) })} /></DropTarget>;
            })}
            {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="pointer-events-none absolute inset-x-0 z-[1] border-b border-[var(--glass-divider)]" style={{ top: hour * hourHeight, height: hourHeight }} />)}
            <div data-testid="plan-task-lane" className="pointer-events-none absolute inset-y-0 right-0 z-[2]" style={{ left: banded && !week ? 'var(--plan-band-rail, 112px)' : 0 }}>
              {groupTimedBlocks(layoutTimed(tasks, day)).map((group) => week && group.length > 1 && !group.some((block) => block.task.id === activeTaskId) ? <OverlapGroup key={group[0].id} group={group} day={day} onOpen={(trigger) => { overlapOpener.current = trigger; openingTask.current = false; setOverlap({ day, taskIds: group.map((block) => block.task.id) }); }} /> : group.map((block) => <TimedTask key={block.id} block={block} dateKey={day} busy={busy} onOpen={onOpen} onToggle={onToggle} />))}
            </div>
            <NowLine dateKey={day} today={today} />
          </div>;
        })}
      </div>
    </div>
  </div></div>
    <Dialog open={Boolean(overlap)} onOpenChange={(open) => { if (!open) setOverlap(null); }}><DialogContent surface="glass" onCloseAutoFocus={(event) => { if (openingTask.current) return; event.preventDefault(); (overlapOpener.current?.isConnected ? overlapOpener.current : calendar.current)?.focus({ preventScroll: true }); }}><DialogHeader><DialogTitle>重叠任务</DialogTitle><DialogDescription>{overlap?.day} · 打开任务可调整安排时间。</DialogDescription></DialogHeader><div className="max-h-[60vh] space-y-2 overflow-y-auto">{overlapTasks.length ? overlapTasks.map((task) => <div key={task.id} className="flex items-start gap-3 rounded-lg border border-[var(--glass-divider)] p-3"><Check task={task} busy={busy} onToggle={onToggle} /><button type="button" className="min-w-0 flex-1 text-left" onClick={() => { openingTask.current = true; setOverlap(null); onOpen(task.id); }}><span className="block break-words text-sm">{task.title}</span><span className="text-xs text-muted-foreground">{scheduleLabel(task)}</span></button></div>) : <p className="text-sm text-muted-foreground">这些任务已完成或已移出当前范围。</p>}</div></DialogContent></Dialog>
  </>;
}
function CreateScheduledTask({ initial, topics, onClose, onCreate }: { initial: ScheduleValue; topics: Topic[]; onClose: () => void; onCreate: Props['onCreate'] }) {
  const [value, setValue] = useState(initial);
  const [title, setTitle] = useState('');
  const [topicId, setTopicId] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const composing = useRef(false);
  return <Dialog open onOpenChange={(open) => { if (!open && !lock.current) onClose(); }}><DialogContent surface="glass" className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>创建任务</DialogTitle><DialogDescription>填写标题并确认安排时间。</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (lock.current || composing.current || !title.trim() || scheduleError(value)) return; lock.current = true; setSaving(true); void onCreate({ title: title.trim(), topicId: topicId || null, parentId: null, ...value }).then(onClose).catch(() => undefined).finally(() => { lock.current = false; setSaving(false); }); }}>
      <Input aria-label="任务标题" autoFocus value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || isCompositionKey(event.nativeEvent))) event.preventDefault(); }} />
      <label className="block text-sm">所属清单<select aria-label="所属清单" className="glass-control mt-1 h-9 w-full rounded px-2" value={topicId} disabled={saving} onChange={(event) => setTopicId(event.target.value)}><option value="">收集箱</option>{topics.filter((topic) => !topic.archivedAt).map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
      <ScheduleFields value={value} onChange={setValue} disabled={saving} />
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>取消</Button><Button type="submit" disabled={saving || !title.trim() || Boolean(scheduleError(value))}>{saving ? '创建中…' : '创建任务'}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export function PlanPage({ topics, onOpen, onToggle, onSave, onCreate, busy }: Props) {
  const today = useLocalDate();
  const timeBands = usePlanTimeBands();
  const [mode, setMode] = useState<Mode>(readPlanMode);
  const chooseMode = (next: Mode) => { setMode(next); localStorage.setItem('todo.plan.mode', next); };
  const [anchor, setAnchor] = useState(today);
  const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem('todo.plan.showCompleted') === 'true');
  const [trayOpen, setTrayOpen] = useState(false);
  const [allDayOpen, setAllDayOpen] = useState<boolean | null>(() => {
    const stored = localStorage.getItem('todo.plan.allDayOpen');
    return stored === 'true' ? true : stored === 'false' ? false : null;
  });
  const [trayFilter, setTrayFilter] = useState('unplanned');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState<Task | null>(null);
  const [preview, setPreview] = useState<{ task: Task; patch: SchedulePatch } | null>(null);
  const [creating, setCreating] = useState<ScheduleValue | null>(null);
  const previewRef = useRef(preview);
  const dragData = useRef<{ task: Task; edge?: 'start' | 'end'; offset?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const range = rangeOf(mode, anchor);
  usePageContext('plan', { label: `${mode === 'day' ? '日' : mode === 'week' ? '周' : '月'}规划 · ${range[0]}–${range[1]}`, taskFilter: { status: showCompleted ? 'all' : 'open', scheduledFrom: range[0], scheduledTo: range[1] }, pageState: { layout: mode, dateFrom: range[0], dateTo: range[1], anchor, showCompleted } });
  const planned = useTasks({ status: showCompleted ? 'all' : 'open', scheduledFrom: range[0], scheduledTo: range[1] });
  const trayQuery = useTasks({ status: 'open', sort: 'date' });
  const tasks = (planned.data ?? []).map((task) => preview?.task.id === task.id ? { ...task, ...preview.patch } : task);
  const tray = useMemo(() => (trayQuery.data ?? []).filter((task) => (trayFilter === 'all' || (trayFilter === 'unplanned' ? !scheduleDateKey(task) : Boolean(scheduleDateKey(task)))) && task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => Number(isOverdue(b, today)) - Number(isOverdue(a, today)) || (scheduleDateKey(a) ?? '').localeCompare(scheduleDateKey(b) ?? '') || a.id.localeCompare(b.id)), [trayQuery.data, trayFilter, search, today]);
  const disabled = busy || saving;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const clearDrag = () => { setDragging(null); setPreview(null); previewRef.current = null; dragData.current = null; };
  const save = async (task: Task, patch: SchedulePatch) => {
    if (saveLock.current) return;
    saveLock.current = true; setSaving(true);
    try { await onSave(task, patch); } catch { /* Shared writer displays errors and refreshes version conflicts. */ }
    finally { saveLock.current = false; setSaving(false); }
  };
  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    dragData.current = data ? { task: data.task, edge: data.edge, offset: data.offset } : null;
    setDragging(data?.edge ? null : data?.task ?? null);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const data = dragData.current;
    if (!data?.edge) return;
    const patch = resizeSchedule(data.task, data.edge, event.delta.y / hourHeight * 60);
    previewRef.current = patch ? { task: data.task, patch } : null;
    setPreview(previewRef.current);
  };
  const dropPatch = (event: DragEndEvent | DragOverEvent): SchedulePatch | null => {
    const data = dragData.current;
    if (!data?.task || !event.over) return null;
    const target = String(event.over.id);
    const patch = applyDrop(data.task, target);
    if (!patch || !data.offset || !data.task.scheduledStart) return patch;
    // Grabbing a continuation moves the grabbed day's segment, not the original first day.
    if (target.startsWith('slot:') && patch.scheduledStart) {
      patch.scheduledStart = addMinutes(patch.scheduledStart, -data.offset);
      patch.scheduledEnd = data.task.scheduledEnd ? addMinutes(patch.scheduledStart, minutesBetween(data.task.scheduledStart, data.task.scheduledEnd)) : null;
      patch.dueDate = patch.scheduledStart.slice(0, 10);
    } else if ((target.startsWith('dayhead:') || target.startsWith('cell:')) && patch.dueDate) {
      const dayOffset = Math.round(minutesBetween(`${data.task.scheduledStart.slice(0, 10)}T00:00`, addMinutes(data.task.scheduledStart, data.offset).slice(0, 10) + 'T00:00') / 1440);
      return applyDrop(data.task, `cell:${addDays(patch.dueDate, -dayOffset)}`);
    }
    return patch;
  };
  const onDragEnd = (event: DragEndEvent) => {
    const data = dragData.current;
    const patch = data?.edge ? previewRef.current?.patch : dropPatch(event);
    clearDrag();
    if (data?.task && patch && !disabled) void save(data.task, patch);
  };
  const days = eachDate(range[0], range[1]);
  const error = planned.error || trayQuery.error;
  return <DndContext sensors={sensors} autoScroll={Boolean(dragging)} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={(event) => { if (dragData.current?.edge) return; const patch = dropPatch(event); setPreview(patch && dragData.current ? { task: dragData.current.task, patch } : null); }} onDragEnd={onDragEnd} onDragCancel={clearDrag}>
    <div data-testid="plan-page" className="plan-page mx-auto p-4 pb-10 sm:p-6">
      <header className="plan-header">
        <h1 className="text-2xl font-semibold">规划</h1>
        <Button variant="outline" size="sm" aria-expanded={trayOpen} aria-controls="plan-task-tray" onClick={() => setTrayOpen(!trayOpen)}><PanelRight className="size-4" />待安排<span className="plan-tray-count">{(trayQuery.data ?? []).filter((task) => !scheduleDateKey(task)).length}</span></Button>
      </header>
      <div className="plan-toolbar">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{dateLabel(anchor, { year: 'numeric', month: 'long' })}</span><Button variant="ghost" size="icon-sm" aria-label="上一段" onClick={() => setAnchor(mode === 'month' ? shiftMonth(anchor, -1) : addDays(anchor, mode === 'week' ? -7 : -1))}><ChevronLeft /></Button><Button variant="ghost" size="icon-sm" aria-label="下一段" onClick={() => setAnchor(mode === 'month' ? shiftMonth(anchor, 1) : addDays(anchor, mode === 'week' ? 7 : 1))}><ChevronRight /></Button><Button variant="outline" size="sm" onClick={() => setAnchor(today)}>今天</Button></div>
        <div className="plan-mode-switch">{(['day', 'week', 'month'] as const).map((item) => <button key={item} type="button" data-plan-mode={item} aria-pressed={mode === item} className={cn('rounded-md px-3 py-1.5 text-xs', mode === item ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground')} onClick={() => { clearDrag(); chooseMode(item); }}>{item === 'day' ? '日' : item === 'week' ? '周' : '月'}</button>)}</div>
      </div>
      {error ? <p role="alert" className="text-destructive">{error.message}</p> : planned.isLoading || trayQuery.isLoading ? <p className="py-12 text-center text-muted-foreground">正在加载任务…</p> : <div className="plan-layout" data-tray-open={trayOpen || undefined}>
        <div className="min-w-0">
          {mode !== 'month' ? <Timeline days={days} tasks={tasks} activeTaskId={dragging?.id ?? preview?.task.id} today={today} busy={disabled} bands={timeBands.data?.bands ?? []} allDayOpen={allDayOpen} onAllDayOpen={(open) => { setAllDayOpen(open); localStorage.setItem('todo.plan.allDayOpen', String(open)); }} onOpen={onOpen} onToggle={onToggle} onCreate={setCreating} /> : <div className="overflow-x-auto"><div className="min-w-[560px]">
            <div className="grid grid-cols-7 py-2 text-center text-xs text-muted-foreground">{['一', '二', '三', '四', '五', '六', '日'].map((label) => <div key={label}>{label}</div>)}</div>
            <div className="grid grid-cols-7">{days.map((day) => {
              const items = tasks.filter((task) => occursOn(task, day)).sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? '') || a.id.localeCompare(b.id));
              return <DropTarget key={day} id={`cell:${day}`} className={cn('min-h-28 min-w-0 border-t border-l border-[var(--glass-divider)] p-1 [&:nth-child(7n)]:border-r', day.slice(0, 7) !== anchor.slice(0, 7) && 'opacity-50')}>
                <div className="mb-1 flex justify-between"><button type="button" aria-label={`查看${day}`} className={cn('rounded px-1 text-sm', day === today && 'bg-primary text-primary-foreground')} onClick={() => { setAnchor(day); chooseMode('day'); }}>{Number(day.slice(8))}</button><button type="button" aria-label={`在${day}添加全天任务`} disabled={disabled} onClick={() => setCreating({ dueDate: day, scheduledStart: null, scheduledEnd: null })}>＋</button></div>
                {items.slice(0, 3).map((task) => <DragTask key={task.id} task={task} instance={`month:${day}`} offset={task.scheduledStart && day !== task.scheduledStart.slice(0, 10) ? minutesBetween(task.scheduledStart, `${day}T00:00`) : 0} busy={disabled}><button type="button" title={scheduleLabel(task)} className={cn('mb-1 block w-full truncate rounded px-1 text-left text-[11px]', task.status === 'done' && 'opacity-55 line-through')} style={{ borderLeft: `3px solid ${priorityColor(task.priority)}` }} onClick={() => onOpen(task.id)}>{scheduleDateKey(task) !== day ? '↳ ' : task.scheduledStart ? `${formatTime(task.scheduledStart)} ` : ''}{task.title}</button></DragTask>)}
                {items.length > 3 && <button type="button" className="text-xs text-primary" onClick={() => { setAnchor(day); chooseMode('day'); }}>+{items.length - 3} 查看全部</button>}
              </DropTarget>;
            })}</div>
          </div></div>}
        </div>
        <aside id="plan-task-tray" aria-label="待安排任务" hidden={!trayOpen} className="plan-task-tray min-w-0 rounded-xl border border-[var(--glass-divider)] p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-medium"><span>安排任务 · {tray.length}</span><Button variant="ghost" size="icon-sm" aria-label="收起待安排任务" onClick={() => setTrayOpen(false)}><X /></Button></div>
          <Input type="search" aria-label="搜索安排任务" placeholder="搜索任务…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select aria-label="安排任务筛选" value={trayFilter} onChange={(event) => setTrayFilter(event.target.value)} className="glass-control my-2 h-9 w-full rounded px-2 text-sm"><option value="unplanned">未安排</option><option value="planned">已安排</option><option value="all">全部</option></select>
          <DropTarget id="unschedule" className="mb-2 rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">拖到这里取消安排</DropTarget>
          <div className="max-h-64 space-y-1 overflow-y-auto xl:max-h-[60vh]">{!tray.length && <p className="py-6 text-center text-sm text-muted-foreground">没有符合条件的任务</p>}{tray.map((task) => <DragTask key={task.id} task={task} instance="tray" busy={disabled}><button type="button" data-testid="tray-item" className="block w-full cursor-grab rounded-lg px-2 py-2 text-left hover:bg-muted" onClick={() => onOpen(task.id)}><span className="block truncate text-sm">{task.title}</span><span className={cn('block truncate text-[10px] text-muted-foreground', isOverdue(task, today) && 'text-destructive')}>{isOverdue(task, today) && '逾期 · '}{scheduleLabel(task)}</span></button></DragTask>)}</div>
          <p className="mt-3 text-[11px] text-muted-foreground">可拖动安排，也可打开任务详情编辑时间。</p>
        </aside>
      </div>}
      <footer className="plan-footer"><span className="text-xs text-muted-foreground">{rangeLabel(mode, anchor, range)}</span><div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showCompleted} onChange={(event) => { setShowCompleted(event.target.checked); localStorage.setItem('todo.plan.showCompleted', String(event.target.checked)); }} />显示已完成</label><TimeBandControls /></div></footer>
    </div>
    <DragOverlay>{dragging && <div className="glass-control max-w-64 rounded-lg px-3 py-2 text-sm shadow-lg"><p className="truncate">{dragging.title}</p><p className="text-xs text-muted-foreground">{scheduleLabel({ ...dragging, ...preview?.patch })}</p></div>}</DragOverlay>
    {creating && <CreateScheduledTask initial={creating} topics={topics} onClose={() => setCreating(null)} onCreate={onCreate} />}
  </DndContext>;
}
