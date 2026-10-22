import { useTranslation } from 'react-i18next';
import { usePageContext } from '@/lib/assistant-context.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DragOverEvent } from '@dnd-kit/core';
import type { Tag, Task, Topic } from '@/lib/api.js';
import { useLocalDate, useTasks } from '@/hooks/useTodo.js';
import { addDays, addMinutes, applyDrop, eachDate, formatTime, isOverdue, layoutTimed, localDateTime, minutesBetween, minutesOf, occursOn, rangeOf, resizeSchedule, scheduleDateKey, scheduleLabel, shiftMonth, type SchedulePatch, type TimedBlock } from '@/lib/schedule.js';
import { intlLocale } from '@/i18n/index.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { ScheduleFields, scheduleError, type ScheduleValue } from '@/components/tasks/ScheduleFields.js';
import { keepSchedulePickerOpen } from '@/components/tasks/SchedulePickers.js';
import { isCompositionKey } from '@/lib/todo.js';
import type { PlanTimeBand } from '@/lib/api.js';
import { isoWeekday, planTimeline, planTimelineMinWidth, resolveTimeBandSegments } from '@/lib/plan-time-bands.js';
import { TimeBandLayer } from './TimeBandLayer.js';
import { TimeBandControls } from './TimeBandDialog.js';
import { usePlanTimeBands } from './usePlanTimeBands.js';
import { ChevronLeft, ChevronRight, PanelRight, X } from 'lucide-react';
import { laneCap, layoutLanes, type LaneMore } from '@/lib/plan-layout.js';

type Mode = 'day' | 'week' | 'month';
function readPlanMode(): Mode {
  const stored = localStorage.getItem('todo.plan.mode');
  return stored === 'day' || stored === 'week' || stored === 'month' ? stored : 'week';
}
function readPlanAnchor(today: string) {
  const stored = localStorage.getItem('todo.plan.anchor');
  if (!stored || !/^\d{4}-\d{2}-\d{2}$/.test(stored)) return today;
  const [year, month, day] = stored.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? stored : today;
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
const weekdayIds = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
function dateLabel(value: string, options: Intl.DateTimeFormatOptions) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), options).format(new Date(year, month - 1, day));
}
function rangeLabel(mode: Mode, anchor: string, range: [string, string]) {
  return mode === 'day' ? `${dateLabel(anchor, { month: 'numeric', day: 'numeric' })} ${dateLabel(anchor, { weekday: 'short' })}` : mode === 'week' ? `${range[0]} — ${range[1]}` : dateLabel(anchor, { year: 'numeric', month: 'long' });
}
function DropTarget({ id, className, style, children }: { id: string; className?: string; style?: CSSProperties; children?: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} data-drop-id={id} style={style} className={cn(className, isOver && 'bg-primary/10 outline-2 outline-primary/40')}>{children}</div>;
}
function DragTask({ task, instance, busy, offset = 0, className, style, lane, laneCount, children }: { task: Task; instance: string; busy: boolean; offset?: number; className?: string; style?: CSSProperties; lane?: number; laneCount?: number; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${task.id}:${instance}`, data: { task, offset }, disabled: busy });
  return <div ref={setNodeRef} style={{ ...style, touchAction: 'manipulation' }} className={cn(className, isDragging && 'opacity-40')} {...listeners} {...attributes} data-lane={lane} data-lane-count={laneCount}>{children}</div>;
}
function ResizeHandle({ task, edge, busy, onOpen }: { task: Task; onOpen: Props['onOpen']; edge: 'start' | 'end'; busy: boolean }) {
  const { t } = useTranslation('plan');
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `${task.id}:resize:${edge}`, data: { task, edge }, disabled: busy });
  return <button type="button" ref={setNodeRef} {...attributes} {...listeners} onPointerDown={(event) => { event.stopPropagation(); listeners?.onPointerDown?.(event); }} aria-label={t(edge === 'start' ? 'plan.resizeStart' : 'plan.resizeEnd', { title: task.title })} title={t('plan.resizeHint')} style={{ touchAction: 'none' }} onClick={(event) => { event.stopPropagation(); onOpen(task.id); }} className={cn('absolute inset-x-1 z-10 h-2 cursor-ns-resize rounded focus-visible:bg-primary/30', edge === 'start' ? 'top-0' : 'bottom-0')} />;
}
function Check({ task, busy, onToggle }: { task: Task; busy: boolean; onToggle: Props['onToggle'] }) {
  const { t } = useTranslation('plan');
  return <input type="checkbox" className="task-checkbox size-4 shrink-0 accent-primary" checked={task.status === 'done'} disabled={busy} aria-label={t(task.status === 'done' ? 'plan.reopenTask' : 'plan.completeTask', { title: task.title })} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={() => { void Promise.resolve(onToggle(task)).catch(() => undefined); }} />;
}
function clock(min: number) {
  if (min >= 1440) return '24:00';
  const value = Math.max(0, Math.floor(min));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
function timedRange(block: TimedBlock) {
  return `${block.startsHere ? formatTime(block.task.scheduledStart!) : '00:00'}—${block.endsHere ? formatTime(block.task.scheduledEnd!) : '24:00'}`;
}
function TimedTask({ block, dateKey, busy, left, width, lane, laneCount, onOpen, onToggle }: { block: TimedBlock; dateKey: string; busy: boolean; left: number; width: number; lane: number; laneCount: number; onOpen: Props['onOpen']; onToggle: Props['onToggle'] }) {
  const { t } = useTranslation('plan');
  const task = block.task;
  const height = block.point ? 28 : Math.max(24, (block.endMin - block.startMin) / 60 * hourHeight - 2);
  const top = Math.min(block.startMin / 60 * hourHeight, timelineHeight - height);
  const offset = minutesBetween(task.scheduledStart!, addMinutes(`${dateKey}T00:00`, block.startMin));
  const range = timedRange(block);
  const showInline = !block.point && height < 44;
  const title = <>{block.point && <span>● {formatTime(task.scheduledStart!)} </span>}{!block.startsHere && '↳ '}{task.title}</>;
  return <DragTask task={task} instance={dateKey} offset={offset} busy={busy} lane={lane} laneCount={laneCount} className="plan-lane-card pointer-events-auto absolute z-[2]" style={{ top, height, left: `calc(${left * 100}% + 2px)`, width: `calc(${width * 100}% - 4px)` }}>
    <article data-testid="task-block" data-task-id={task.id} data-date={dateKey} data-point={block.point} title={t('plan.blockTitle', { title: task.title, schedule: scheduleLabel(task) })} className={cn('plan-timed-task relative h-full overflow-hidden rounded-md border px-1.5 text-xs leading-tight', block.point ? 'flex items-center border-dashed' : 'pt-2 pb-1', task.status === 'done' && 'opacity-55 line-through')}>
      {!block.point && block.startsHere && <ResizeHandle task={task} edge="start" busy={busy} onOpen={onOpen} />}
      <div className="flex min-w-0 items-start gap-1">
        <Check task={task} busy={busy} onToggle={onToggle} />
        <button type="button" className="min-w-0 flex-1 text-left" aria-label={t('plan.openTask', { title: task.title })} onClick={() => onOpen(task.id)}>
          {showInline ? <span className="flex w-full min-w-0 items-start gap-1"><span className="plan-task-title min-w-0 flex-1">{title}</span><span className="plan-timed-when-inline shrink-0 whitespace-nowrap text-[10px] text-muted-foreground tabular-nums">{range}</span></span> : <span className="plan-task-title block">{title}</span>}
          {height >= 44 && <span className="plan-timed-when block truncate text-[10px] text-muted-foreground tabular-nums">{range}</span>}
        </button>
      </div>
      {!block.point && block.endsHere && <ResizeHandle task={task} edge="end" busy={busy} onOpen={onOpen} />}
    </article>
  </DragTask>;
}
function LaneMoreButton({ more, onOpen }: { more: LaneMore; onOpen: (button: HTMLButtonElement, taskIds: string[]) => void }) {
  const { t } = useTranslation('plan');
  const height = Math.max(24, (more.endMin - more.startMin) / 60 * hourHeight - 2);
  const top = Math.min(more.startMin / 60 * hourHeight, timelineHeight - height);
  const count = more.blocks.length;
  return <button type="button" data-testid="plan-lane-more" aria-haspopup="dialog" className="plan-lane-more pointer-events-auto absolute z-[3]" style={{ top, height, left: `calc(${more.left * 100}% + 2px)`, width: `calc(${more.width * 100}% - 4px)` }} aria-label={t('plan.laneMoreLabel', { count, start: clock(more.startMin), end: clock(more.endMin) })} title={more.blocks.map((block) => `${clock(block.startMin)}—${clock(block.endMin)} ${block.task.title}`).join('\n')} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => onOpen(event.currentTarget, more.blocks.map((block) => block.task.id))}>{t('plan.laneMore', { count })}</button>;
}
function NowLine({ dateKey, today }: { dateKey: string; today: string }) {
  const [now, setNow] = useState(localDateTime);
  useEffect(() => { const timer = window.setInterval(() => setNow(localDateTime()), 30000); return () => window.clearInterval(timer); }, []);
  return dateKey === today ? <div className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-destructive" style={{ top: minutesOf(now) / 60 * hourHeight }} /> : null;
}
const allDayPreviewLimit = 2;
function Timeline({ days, tasks, today, busy, bands, allDayOpen, onAllDayOpen, onOpen, onToggle, onCreate, activeTaskId }: { days: string[]; tasks: Task[]; today: string; busy: boolean; bands: readonly PlanTimeBand[]; allDayOpen: boolean | null; onAllDayOpen: (open: boolean) => void; onOpen: Props['onOpen']; onToggle: Props['onToggle']; onCreate: (value: ScheduleValue) => void; activeTaskId: string | null }) {
  const { t } = useTranslation('plan');
  const scroller = useRef<HTMLDivElement>(null);
  const calendar = useRef<HTMLDivElement>(null);
  const overlapOpener = useRef<HTMLButtonElement | null>(null);
  const openingTask = useRef(false);
  const [overlap, setOverlap] = useState<{ day: string; taskIds: string[] } | null>(null);
  const [laneCaps, setLaneCaps] = useState<Record<string, number>>({});
  const overlapTasks = overlap ? overlap.taskIds.flatMap((id) => { const task = tasks.find((item) => item.id === id); return task ? [task] : []; }) : [];
  const week = days.length === 7;
  const columns = `${planTimeline.hourGutter}px repeat(${days.length}, minmax(0, 1fr))`;
  const bandDays = new Set(days.filter((day) => resolveTimeBandSegments(bands, isoWeekday(day)).length > 0));
  const allDayByDay = new Map(days.map((day) => [day, tasks.filter((task) => !task.scheduledStart && task.dueDate === day)]));
  const hasAllDay = [...allDayByDay.values()].some((items) => items.length > 0);
  const allDayExpanded = allDayOpen ?? ![...allDayByDay.values()].some((items) => items.length > allDayPreviewLimit);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, minutesOf(localDateTime()) / 60 * hourHeight - 120); }, [days[0], days.length]);
  useLayoutEffect(() => {
    const root = calendar.current;
    if (!root) return;
    const measure = () => {
      const next: Record<string, number> = {};
      for (const lane of root.querySelectorAll<HTMLElement>('[data-testid="plan-task-lane"]')) {
        const day = lane.closest<HTMLElement>('[data-testid="time-band-day"]')?.dataset.date;
        if (day) next[day] = laneCap(lane.clientWidth);
      }
      setLaneCaps((prev) => Object.keys(next).some((day) => (prev[day] ?? laneCap(0)) !== next[day]) ? next : prev);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const lane of root.querySelectorAll<HTMLElement>('[data-testid="plan-task-lane"]')) observer.observe(lane);
    return () => observer.disconnect();
  }, [days[0], days.length]);
  return <><div ref={calendar} role="region" aria-label={t('plan.grid')} tabIndex={-1} data-testid="calendar-horizontal-scroll" data-plan-span={days.length > 1 ? 'week' : 'day'} className={cn('plan-calendar min-w-0 overflow-x-auto', days.length > 1 && 'plan-calendar-week')}><div style={{ minWidth: planTimelineMinWidth(days.length) }}>
    <div className="grid" style={{ gridTemplateColumns: columns }}>
      <div className="min-h-0 self-start p-1 text-center text-[10px] text-muted-foreground">{hasAllDay ? <button type="button" aria-expanded={allDayExpanded} aria-label={allDayExpanded ? t('plan.collapseAllDay') : t('plan.expandAllDay')} className="flex w-full flex-col items-center gap-0.5 rounded py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" onClick={() => onAllDayOpen(!allDayExpanded)}><span className="disclosure-chevron" data-open={allDayExpanded || undefined} aria-hidden="true" />{t('plan.allDay')}</button> : t('plan.allDay')}</div>
      {days.map((day) => {
        const items = allDayByDay.get(day) ?? [];
        const visible = allDayExpanded ? items : items.slice(0, allDayPreviewLimit);
        const hidden = items.length - visible.length;
        return <div key={day} className="min-h-0 min-w-0 border-l border-[var(--glass-divider)]">
          <DropTarget id={`dayhead:${day}`} className="plan-day-heading p-1 text-center text-xs"><button type="button" onClick={() => onCreate({ dueDate: day, scheduledStart: null, scheduledEnd: null })} aria-label={t('plan.addAllDay', { date: day })} className="flex w-full items-center justify-center gap-2 rounded py-2 hover:bg-muted"><span className="text-muted-foreground">{dateLabel(day, { weekday: 'short' })}</span><span className={cn('inline-grid size-7 place-items-center rounded-full text-sm', day === today && 'bg-primary text-primary-foreground')}>{Number(day.slice(8))}</span></button></DropTarget>
          <DropTarget id={`allday:${day}`} className={cn('min-h-12 space-y-1 p-1', allDayExpanded && 'max-h-36 overflow-y-auto')}>
            {visible.map((task) => <DragTask key={task.id} task={task} instance={`all:${day}`} busy={busy}><div className={cn('flex items-center gap-1 rounded bg-muted/50 px-1 py-1 text-xs', task.status === 'done' && 'opacity-55 line-through')}><Check task={task} busy={busy} onToggle={onToggle} /><button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(task.id)}>{task.title}</button></div></DragTask>)}
            {hidden > 0 && <button type="button" className="task-fold min-w-0" onClick={() => onAllDayOpen(true)}><span className="min-w-0 truncate">{t('plan.more', { count: hidden })}</span></button>}
          </DropTarget>
        </div>;
      })}
    </div>
    <div ref={scroller} data-testid="timeline-scroll" className="max-h-[65vh] overflow-y-auto border-t border-[var(--glass-divider)]">
      <div className="grid" style={{ gridTemplateColumns: columns, height: timelineHeight }}>
        <div>{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="border-b border-[var(--glass-divider)] pr-1 text-right text-[10px] tabular-nums text-muted-foreground" style={{ height: hourHeight }}>{String(hour).padStart(2, '0')}:00</div>)}</div>
        {days.map((day) => {
          const banded = bandDays.has(day);
          const { placed, mores } = layoutLanes(layoutTimed(tasks, day), laneCaps[day] ?? laneCap(0), { pinnedTaskId: activeTaskId ?? undefined });
          return <div key={day} data-testid="time-band-day" data-date={day} data-band-rail={banded ? 'true' : 'false'} className="relative isolate border-l border-[var(--glass-divider)]">
            <TimeBandLayer bands={bands} dateKey={day} />
            {banded && !week && <div data-testid="time-band-rail" className="pointer-events-none absolute inset-y-0 z-[1] border-r border-[var(--glass-divider)]" style={{ width: 'var(--plan-band-rail, 112px)' }} />}
            {Array.from({ length: 48 }, (_, index) => {
              const start = addMinutes(`${day}T00:00`, index * 30);
              const id = `slot:${day}:${start.slice(11, 13)}:${start.slice(14, 16)}`;
              return <DropTarget key={id} id={id} className="absolute inset-x-0 z-[1]" style={{ top: index * hourHeight / 2, height: hourHeight / 2 }}><button type="button" disabled={busy} aria-label={t('plan.addAt', { when: start.replace('T', ' ') })} className="h-full w-full bg-transparent hover:bg-primary/5 focus-visible:bg-primary/10" onClick={() => onCreate({ dueDate: day, scheduledStart: start, scheduledEnd: addMinutes(start, 60) })} /></DropTarget>;
            })}
            {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="pointer-events-none absolute inset-x-0 z-[1] border-b border-[var(--glass-divider)]" style={{ top: hour * hourHeight, height: hourHeight }} />)}
            <div data-testid="plan-task-lane" className="pointer-events-none absolute inset-y-0 right-0 z-[2]" style={{ left: banded && !week ? 'var(--plan-band-rail, 112px)' : 0 }}>
              {placed.map((item) => <TimedTask key={item.block.id} block={item.block} dateKey={day} left={item.left} width={item.width} lane={item.lane} laneCount={item.laneCount} busy={busy} onOpen={onOpen} onToggle={onToggle} />)}
              {mores.map((more) => <LaneMoreButton key={more.id} more={more} onOpen={(button, taskIds) => { overlapOpener.current = button; openingTask.current = false; setOverlap({ day, taskIds }); }} />)}
            </div>
            <NowLine dateKey={day} today={today} />
          </div>;
        })}
      </div>
    </div>
  </div></div>
    <Dialog open={Boolean(overlap)} onOpenChange={(open) => { if (!open) setOverlap(null); }}><DialogContent surface="glass" onCloseAutoFocus={(event) => { if (openingTask.current) return; event.preventDefault(); (overlapOpener.current?.isConnected ? overlapOpener.current : calendar.current)?.focus({ preventScroll: true }); }}><DialogHeader><DialogTitle>{t('plan.overlapTitle')}</DialogTitle><DialogDescription>{t('plan.overlapDescription', { day: overlap?.day ?? '' })}</DialogDescription></DialogHeader><div className="max-h-[60vh] space-y-2 overflow-y-auto">{overlapTasks.length ? overlapTasks.map((task) => <div key={task.id} className="flex items-start gap-3 rounded-lg border border-[var(--glass-divider)] p-3"><Check task={task} busy={busy} onToggle={onToggle} /><button type="button" className="min-w-0 flex-1 text-left" onClick={() => { openingTask.current = true; setOverlap(null); onOpen(task.id); }}><span className="block break-words text-sm">{task.title}</span><span className="text-xs text-muted-foreground">{scheduleLabel(task)}</span></button></div>) : <p className="text-sm text-muted-foreground">{t('plan.overlapEmpty')}</p>}</div></DialogContent></Dialog>
  </>;
}
function CreateScheduledTask({ initial, topics, onClose, onCreate }: { initial: ScheduleValue; topics: Topic[]; onClose: () => void; onCreate: Props['onCreate'] }) {
  const { t } = useTranslation('plan');
  const [value, setValue] = useState(initial);
  const [title, setTitle] = useState('');
  const [topicId, setTopicId] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const composing = useRef(false);
  return <Dialog open onOpenChange={(open) => { if (!open && !lock.current) onClose(); }}><DialogContent surface="glass" className="max-h-[90dvh] overflow-y-auto" onPointerDownOutside={keepSchedulePickerOpen} onInteractOutside={keepSchedulePickerOpen} onFocusOutside={keepSchedulePickerOpen}><DialogHeader><DialogTitle>{t('plan.createTitle')}</DialogTitle><DialogDescription>{t('plan.createDescription')}</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (lock.current || composing.current || !title.trim() || scheduleError(value)) return; lock.current = true; setSaving(true); void onCreate({ title: title.trim(), topicId: topicId || null, parentId: null, ...value }).then(onClose).catch(() => undefined).finally(() => { lock.current = false; setSaving(false); }); }}>
      <Input aria-label={t('plan.taskTitle')} autoFocus value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || isCompositionKey(event.nativeEvent))) event.preventDefault(); }} />
      <label className="block text-sm">{t('plan.list')}<select aria-label={t('plan.list')} className="glass-control mt-1 h-9 w-full rounded px-2" value={topicId} disabled={saving} onChange={(event) => setTopicId(event.target.value)}><option value="">{t('plan.inbox')}</option>{topics.filter((topic) => !topic.archivedAt).map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
      <ScheduleFields value={value} onChange={setValue} disabled={saving} />
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t('shared.cancel')}</Button><Button type="submit" disabled={saving || !title.trim() || Boolean(scheduleError(value))}>{saving ? t('plan.creating') : t('plan.create')}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export function PlanPage({ topics, onOpen, onToggle, onSave, onCreate, busy }: Props) {
  const { t } = useTranslation('plan');
  const today = useLocalDate();
  const timeBands = usePlanTimeBands();
  const [mode, setMode] = useState<Mode>(readPlanMode);
  const chooseMode = (next: Mode) => { setMode(next); localStorage.setItem('todo.plan.mode', next); };
  const [anchor, setAnchor] = useState(() => readPlanAnchor(today));
  const chooseAnchor = (next: string) => { setAnchor(next); localStorage.setItem('todo.plan.anchor', next); };
  const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem('todo.plan.showCompleted') === 'true');
  const [trayOpen, setTrayOpen] = useState(false);
  const [allDayOpen, setAllDayOpen] = useState<boolean | null>(() => {
    const stored = localStorage.getItem('todo.plan.allDayOpen');
    return stored === 'true' ? true : stored === 'false' ? false : null;
  });
  const [trayFilter, setTrayFilter] = useState('unplanned');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState<Task | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ task: Task; patch: SchedulePatch } | null>(null);
  const [creating, setCreating] = useState<ScheduleValue | null>(null);
  const previewRef = useRef(preview);
  const dragData = useRef<{ task: Task; edge?: 'start' | 'end'; offset?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const range = rangeOf(mode, anchor);
  const span = t(mode === 'day' ? 'plan.spanDay' : mode === 'week' ? 'plan.spanWeek' : 'plan.spanMonth');
  usePageContext('plan', { label: t('plan.contextLabel', { span, from: range[0], to: range[1] }), taskFilter: { status: showCompleted ? 'all' : 'open', scheduledFrom: range[0], scheduledTo: range[1] }, pageState: { layout: mode, dateFrom: range[0], dateTo: range[1], anchor, showCompleted } });
  const planned = useTasks({ status: showCompleted ? 'all' : 'open', scheduledFrom: range[0], scheduledTo: range[1] });
  const trayQuery = useTasks({ status: 'open', sort: 'date' });
  const tasks = (planned.data ?? []).map((task) => preview?.task.id === task.id ? { ...task, ...preview.patch } : task);
  const tray = useMemo(() => (trayQuery.data ?? []).filter((task) => (trayFilter === 'all' || (trayFilter === 'unplanned' ? !scheduleDateKey(task) : Boolean(scheduleDateKey(task)))) && task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => Number(isOverdue(b, today)) - Number(isOverdue(a, today)) || (scheduleDateKey(a) ?? '').localeCompare(scheduleDateKey(b) ?? '') || a.id.localeCompare(b.id)), [trayQuery.data, trayFilter, search, today]);
  const disabled = busy || saving;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const clearDrag = () => { setDragging(null); setActiveTaskId(null); setPreview(null); previewRef.current = null; dragData.current = null; };
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
    setActiveTaskId(data?.task?.id ?? null);
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
        <h1 className="text-2xl font-semibold">{t('plan.title')}</h1>
        <Button variant="outline" size="sm" aria-expanded={trayOpen} aria-controls="plan-task-tray" onClick={() => setTrayOpen(!trayOpen)}><PanelRight className="size-4" />{t('plan.toSchedule')}<span className="plan-tray-count">{(trayQuery.data ?? []).filter((task) => !scheduleDateKey(task)).length}</span></Button>
      </header>
      <div className="plan-toolbar">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{dateLabel(anchor, { year: 'numeric', month: 'long' })}</span><Button variant="ghost" size="icon-sm" aria-label={t('plan.previous')} onClick={() => chooseAnchor(mode === 'month' ? shiftMonth(anchor, -1) : addDays(anchor, mode === 'week' ? -7 : -1))}><ChevronLeft /></Button><Button variant="ghost" size="icon-sm" aria-label={t('plan.next')} onClick={() => chooseAnchor(mode === 'month' ? shiftMonth(anchor, 1) : addDays(anchor, mode === 'week' ? 7 : 1))}><ChevronRight /></Button><Button variant="outline" size="sm" onClick={() => chooseAnchor(today)}>{t('plan.today')}</Button></div>
        <div className="plan-mode-switch">{(['day', 'week', 'month'] as const).map((item) => <button key={item} type="button" data-plan-mode={item} aria-pressed={mode === item} className={cn('rounded-md px-3 py-1.5 text-xs', mode === item ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground')} onClick={() => { clearDrag(); chooseMode(item); }}>{t(item === 'day' ? 'plan.spanDay' : item === 'week' ? 'plan.spanWeek' : 'plan.spanMonth')}</button>)}</div>
      </div>
      {error ? <p role="alert" className="text-destructive">{error.message}</p> : planned.isLoading || trayQuery.isLoading ? <p className="py-12 text-center text-muted-foreground">{t('shared.loadingTasks')}</p> : <div className="plan-layout" data-tray-open={trayOpen || undefined}>
        <div className="min-w-0">
          {mode !== 'month' ? <Timeline days={days} tasks={tasks} today={today} busy={disabled} bands={timeBands.data?.bands ?? []} allDayOpen={allDayOpen} onAllDayOpen={(open) => { setAllDayOpen(open); localStorage.setItem('todo.plan.allDayOpen', String(open)); }} onOpen={onOpen} onToggle={onToggle} onCreate={setCreating} activeTaskId={activeTaskId} /> : <div data-testid="month-horizontal-scroll" className="plan-month-scroll overflow-x-auto max-sm:overflow-visible"><div className="min-w-[560px] max-sm:min-w-0">
            <div className="grid grid-cols-7 py-2 text-center text-xs text-muted-foreground">{weekdayIds.map((day) => <div key={day}>{t(`weekday.${day}.narrow`)}</div>)}</div>
            <div className="grid grid-cols-7">{days.map((day) => {
              const items = tasks.filter((task) => occursOn(task, day)).sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? '') || a.id.localeCompare(b.id));
              return <DropTarget key={day} id={`cell:${day}`} className={cn('plan-month-cell min-h-[76px] sm:min-h-28 min-w-0 border-t border-l border-[var(--glass-divider)] p-1 [&:nth-child(7n)]:border-r', day.slice(0, 7) !== anchor.slice(0, 7) && 'opacity-50')}>
                <div className="mb-1 flex justify-between"><button type="button" aria-label={t('plan.viewDay', { date: day })} className={cn('rounded px-1 text-sm', day === today && 'bg-primary text-primary-foreground')} onClick={() => { chooseAnchor(day); chooseMode('day'); }}>{Number(day.slice(8))}</button><button type="button" aria-label={t('plan.addAllDay', { date: day })} className="plan-month-add max-sm:hidden" disabled={disabled} onClick={() => setCreating({ dueDate: day, scheduledStart: null, scheduledEnd: null })}>{t('plan.addMark')}</button></div>
                {items.slice(0, 3).map((task) => {
                  const continued = scheduleDateKey(task) !== day;
                  return <DragTask key={task.id} task={task} instance={`month:${day}`} offset={task.scheduledStart && day !== task.scheduledStart.slice(0, 10) ? minutesBetween(task.scheduledStart, `${day}T00:00`) : 0} busy={disabled}><button type="button" title={scheduleLabel(task)} className={cn('plan-month-task mb-1 flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px]', task.status === 'done' && 'opacity-55 line-through')} onClick={() => onOpen(task.id)}>{continued ? <span className="shrink-0 tabular-nums text-muted-foreground">↳</span> : task.scheduledStart ? <span className="plan-month-time max-sm:hidden shrink-0 tabular-nums text-muted-foreground">{formatTime(task.scheduledStart)}</span> : null}<span className="min-w-0 flex-1 truncate">{task.title}</span></button></DragTask>;
                })}
                {items.length > 3 && <button type="button" className="px-1 text-xs text-muted-foreground" aria-label={t('plan.moreTasks', { date: day, count: items.length - 3 })} onClick={() => { chooseAnchor(day); chooseMode('day'); }}>+{items.length - 3}</button>}
              </DropTarget>;
            })}</div>
          </div></div>}
        </div>
        <aside id="plan-task-tray" aria-label={t('plan.trayLabel')} hidden={!trayOpen} className="plan-task-tray min-w-0 rounded-xl border border-[var(--glass-divider)] p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-medium"><span>{t('plan.trayTitle', { total: tray.length })}</span><Button variant="ghost" size="icon-sm" aria-label={t('plan.hideTray')} onClick={() => setTrayOpen(false)}><X /></Button></div>
          <Input type="search" aria-label={t('plan.searchLabel')} placeholder={t('plan.searchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <select aria-label={t('plan.filterLabel')} value={trayFilter} onChange={(event) => setTrayFilter(event.target.value)} className="glass-control my-2 h-9 w-full rounded px-2 text-sm"><option value="unplanned">{t('schedule.unscheduled')}</option><option value="planned">{t('plan.scheduled')}</option><option value="all">{t('plan.all')}</option></select>
          <DropTarget id="unschedule" className="mb-2 rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">{t('plan.dropUnschedule')}</DropTarget>
          <div className="max-h-64 space-y-1 overflow-y-auto xl:max-h-[60vh]">{!tray.length && <p className="py-6 text-center text-sm text-muted-foreground">{t('plan.noMatches')}</p>}{tray.map((task) => <DragTask key={task.id} task={task} instance="tray" busy={disabled}><button type="button" data-testid="tray-item" className="block w-full cursor-grab rounded-lg px-2 py-2 text-left hover:bg-muted" onClick={() => onOpen(task.id)}><span className="block truncate text-sm">{task.title}</span><span className={cn('block truncate text-[10px] text-muted-foreground', isOverdue(task, today) && 'text-destructive')}>{isOverdue(task, today) ? t('plan.overdue', { label: scheduleLabel(task) }) : scheduleLabel(task)}</span></button></DragTask>)}</div>
          <p className="mt-3 text-[11px] text-muted-foreground">{t('plan.trayHint')}</p>
        </aside>
      </div>}
      <footer className="plan-footer"><span className="text-xs text-muted-foreground">{rangeLabel(mode, anchor, range)}</span><div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showCompleted} onChange={(event) => { setShowCompleted(event.target.checked); localStorage.setItem('todo.plan.showCompleted', String(event.target.checked)); }} />{t('shared.showCompleted')}</label><TimeBandControls /></div></footer>
    </div>
    <DragOverlay>{dragging && <div className="glass-control max-w-64 rounded-lg px-3 py-2 text-sm shadow-lg"><p className="truncate">{dragging.title}</p><p className="text-xs text-muted-foreground">{scheduleLabel({ ...dragging, ...preview?.patch })}</p></div>}</DragOverlay>
    {creating && <CreateScheduledTask initial={creating} topics={topics} onClose={() => setCreating(null)} onCreate={onCreate} />}
  </DndContext>;
}
