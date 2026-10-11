import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import type { Tag, Task, Topic } from '@/lib/api.js';
import { useLocalDate, useTasks } from '@/hooks/useTodo.js';
import { addDays, applyDrop, eachDate, formatTime, layoutTimed, localDateTime, minutesOf, mondayOf, rangeOf, scheduleDateKey, type TimedBlock } from '@/lib/schedule.js';
import { cn } from '@/lib/utils.js';

type Mode = 'day' | 'week' | 'month';
type Props = {
  topics: Topic[];
  tags: Tag[];
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<Task | undefined> | void;
  onSave: (task: Task, patch: Partial<Pick<Task, 'dueDate' | 'scheduledStart' | 'scheduledEnd' | 'estimatedMinutes'>>) => Promise<Task | undefined> | void;
  onDelete: (task: Task) => void;
  busy: boolean;
};

const dayHour = 56;
const weekHeight = 672;
const weekStartMin = 6 * 60;
const weekSpan = 18 * 60;

function priorityColor(priority: Task['priority']) {
  if (priority === 'high') return 'var(--destructive)';
  if (priority === 'medium') return 'var(--warning)';
  if (priority === 'low') return 'var(--primary)';
  return 'var(--muted-foreground)';
}
function dateLabel(value: string, options: Intl.DateTimeFormatOptions) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(year, month - 1, day));
}
function shiftAnchor(mode: Mode, anchor: string, direction: -1 | 1) {
  if (mode === 'day') return addDays(anchor, direction);
  if (mode === 'week') return addDays(anchor, direction * 7);
  const [year, month, day] = anchor.split('-').map(Number);
  const date = new Date(year, month - 1 + direction, day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function rangeLabel(mode: Mode, anchor: string, range: [string, string]) {
  if (mode === 'day') return `${dateLabel(anchor, { month: 'numeric', day: 'numeric' })} ${dateLabel(anchor, { weekday: 'short' })}`;
  if (mode === 'week') return `${dateLabel(range[0], { month: 'numeric', day: 'numeric' })} - ${dateLabel(range[1], { month: 'numeric', day: 'numeric' })}`;
  return dateLabel(anchor, { year: 'numeric', month: 'long' });
}

function DropTarget({ id, className, style, children, onClick }: { id: string; className?: string; style?: CSSProperties; children?: ReactNode; onClick?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} data-drop-id={id} style={style} onClick={onClick} className={cn(className, isOver && 'outline-2 outline-[var(--primary)]/40')}>{children}</div>;
}

function DragTask({ task, className, style, children }: { task: Task; className?: string; style?: CSSProperties; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { task }, disabled: false });
  return <div ref={setNodeRef} style={style} className={cn(className, isDragging && 'opacity-40')} {...listeners} {...attributes}>{children}</div>;
}

function Check({ task, busy, onToggle }: { task: Task; busy: boolean; onToggle: Props['onToggle'] }) {
  return <input type="checkbox" className="task-checkbox size-4 shrink-0 accent-primary" checked={task.status === 'done'} disabled={busy} aria-label={`${task.status === 'done' ? '重开' : '完成'}任务：${task.title}`} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onChange={() => { void onToggle(task); }} />;
}

function TimedTask({ block, compact, scale, origin, busy, onOpen, onToggle }: { block: TimedBlock; compact?: boolean; scale: number; origin: number; busy: boolean; onOpen: Props['onOpen']; onToggle: Props['onToggle'] }) {
  const task = block.task;
  const top = Math.max(0, (block.startMin - origin) / 60 * scale);
  const height = Math.max(24, (block.endMin - block.startMin) / 60 * scale - 2);
  return <DragTask task={task} className="absolute z-[1]" style={{ top, height, left: `calc(${block.lane / block.laneCount * 100}% + 2px)`, width: `calc(${100 / block.laneCount}% - 4px)` }}>
    <article data-testid="task-block" data-task-id={task.id} className={cn('h-full overflow-hidden rounded-lg border px-2 py-1 text-[13px] leading-tight', task.status === 'done' && 'opacity-55 line-through')} style={{ background: 'var(--glass-control)', borderColor: 'var(--glass-border)', borderLeftWidth: 3, borderLeftColor: priorityColor(task.priority) }}>
      <div className="flex items-start gap-1">
        <Check task={task} busy={busy} onToggle={onToggle} />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(task.id)}>
          {compact ? <span className="block truncate">{formatTime(task.scheduledStart!)} {task.title}</span> : <>
            <span className="block truncate">{task.title}</span>
            {height >= 44 && task.scheduledEnd && <span className="text-[11px] text-muted-foreground tabular-nums">{formatTime(task.scheduledStart!)}-{formatTime(task.scheduledEnd)}</span>}
          </>}
        </button>
      </div>
    </article>
  </DragTask>;
}

function NowLine({ dateKey, today, scale, origin, height }: { dateKey: string; today: string; scale: number; origin: number; height: number }) {
  const [now, setNow] = useState(() => localDateTime());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(localDateTime()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  if (dateKey !== today) return null;
  const top = (minutesOf(now) - origin) / 60 * scale;
  if (top < 0 || top > height) return null;
  return <div className="pointer-events-none absolute right-0 left-0 z-10 h-0.5 bg-[var(--destructive)]" style={{ top }}><span className="absolute top-[-3px] left-0 size-2 rounded-full bg-[var(--destructive)]" /></div>;
}

function DayTimeline({ dateKey, tasks, today, busy, onOpen, onToggle }: { dateKey: string; tasks: Task[]; today: string; busy: boolean; onOpen: Props['onOpen']; onToggle: Props['onToggle'] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = layoutTimed(tasks, dateKey);
  const untimed = tasks.filter((task) => scheduleDateKey(task) === dateKey && !task.scheduledStart);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const top = minutesOf(localDateTime()) / 60 * dayHour - 120;
    node.scrollTop = Math.min(Math.max(top, 0), Math.max(0, node.scrollHeight - node.clientHeight));
  }, [dateKey]);
  return <div>
    <DropTarget id={`allday:${dateKey}`} className="mb-3 flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl px-2" style={{ background: 'color-mix(in srgb, var(--muted) 45%, transparent)' }}>
      {untimed.map((task) => <DragTask key={task.id} task={task}><button type="button" className="rounded-md px-2 py-1 text-xs" onClick={() => onOpen(task.id)}>{task.title}</button></DragTask>)}
    </DropTarget>
    <div ref={scroller} className="max-h-[70vh] overflow-y-auto">
      <div className="flex">
        <div className="w-12 shrink-0">
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="h-14 border-b border-[var(--glass-divider)] pr-2 text-right text-xs text-muted-foreground tabular-nums">{String(hour).padStart(2, '0')}:00</div>)}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: 24 * dayHour }}>
          {Array.from({ length: 48 }, (_, index) => {
            const hour = Math.floor(index / 2);
            const minute = index % 2 ? '30' : '00';
            const id = `slot:${dateKey}:${String(hour).padStart(2, '0')}:${minute}`;
            return <DropTarget key={id} id={id} className="absolute right-0 left-0" style={{ top: index * (dayHour / 2), height: dayHour / 2 }} />;
          })}
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="pointer-events-none absolute right-0 left-0 border-b border-[var(--glass-divider)]" style={{ top: hour * dayHour, height: dayHour }} />)}
          {blocks.map((block) => <TimedTask key={block.id} block={block} scale={dayHour} origin={0} busy={busy} onOpen={onOpen} onToggle={onToggle} />)}
          <NowLine dateKey={dateKey} today={today} scale={dayHour} origin={0} height={24 * dayHour} />
        </div>
      </div>
    </div>
  </div>;
}

function trayOf(tasks: Task[], today: string, rangeEnd: string) {
  const rank = (task: Task) => !task.dueDate ? 1 : task.dueDate < today ? 0 : 2;
  return tasks
    .filter((task) => !task.scheduledStart && !task.scheduledEnd && (!task.dueDate || task.dueDate < today || task.dueDate > rangeEnd))
    .sort((a, b) => rank(a) - rank(b) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.title.localeCompare(b.title, 'zh'))
    .slice(0, 50);
}

export function PlanPage({ onOpen, onToggle, onSave, busy }: Props) {
  const today = useLocalDate();
  const [mode, setMode] = useState<Mode>('day');
  const [anchor, setAnchor] = useState(today);
  const [dragging, setDragging] = useState<Task | null>(null);
  const range = rangeOf(mode, anchor);
  const planned = useTasks({ status: 'open', dueFrom: range[0], dueTo: range[1], scheduledFrom: range[0], scheduledTo: range[1] });
  const trayQuery = useTasks({ status: 'open', sort: 'date' });
  const tasks = planned.data ?? [];
  const tray = useMemo(() => trayOf(trayQuery.data ?? [], today, range[1]), [trayQuery.data, today, range]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragStart = (event: DragStartEvent) => setDragging(event.active.data.current?.task as Task ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    const task = event.active.data.current?.task as Task | undefined;
    setDragging(null);
    if (!task || !event.over) return;
    const patch = applyDrop(task, String(event.over.id));
    if (patch) void onSave(task, patch);
  };
  const days = eachDate(range[0], range[1]);
  const loading = planned.isLoading || trayQuery.isLoading;
  const error = planned.error || trayQuery.error;

  return <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
    <div data-testid="plan-page" className="mx-auto max-w-5xl p-4 pb-10 sm:p-6">
      <header className="mb-4 flex h-12 flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">规划</h1>
        <div className="glass-control inline-flex rounded-full p-1">
          {(['day', 'week', 'month'] as const).map((item) => <button key={item} type="button" data-plan-mode={item} aria-pressed={mode === item} className={cn('h-8 rounded-full px-4 text-sm', mode === item ? 'bg-[var(--glass-hover)] font-medium' : 'text-muted-foreground')} onClick={() => setMode(item)}>{item === 'day' ? '日' : item === 'week' ? '周' : '月'}</button>)}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button type="button" aria-label="上一段" className="grid size-8 place-items-center rounded-full hover:bg-[var(--glass-hover)]" onClick={() => setAnchor(shiftAnchor(mode, anchor, -1))}>‹</button>
          <button type="button" className="rounded-full px-2 py-1 hover:bg-[var(--glass-hover)]" onClick={() => setAnchor(today)}>今天</button>
          <button type="button" aria-label="下一段" className="grid size-8 place-items-center rounded-full hover:bg-[var(--glass-hover)]" onClick={() => setAnchor(shiftAnchor(mode, anchor, 1))}>›</button>
          <span>{rangeLabel(mode, anchor, range)}</span>
        </div>
      </header>
      {loading ? <p className="py-12 text-center text-muted-foreground">正在加载任务…</p> : error ? <p role="alert" className="text-destructive">{error.message}</p> : <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0">
          {!tasks.length && !tray.length && <p className="mb-3 text-center text-sm text-muted-foreground">暂无任务</p>}
          {mode === 'day' && <DayTimeline dateKey={anchor} tasks={tasks} today={today} busy={busy} onOpen={onOpen} onToggle={onToggle} />}
          {mode === 'week' && <div className="max-md:overflow-x-auto"><div className="max-md:min-w-[720px]">
            <div className="grid grid-cols-7">
              {days.map((day) => <DropTarget key={day} id={`dayhead:${day}`} className="py-2 text-center">
                <div className="text-xs text-muted-foreground">{dateLabel(day, { weekday: 'short' })}</div>
                <div className={cn('mx-auto mt-1 grid size-6 place-items-center text-sm font-medium', day === today && 'rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]')}>{Number(day.slice(8))}</div>
              </DropTarget>)}
            </div>
            <div className="grid grid-cols-7" style={{ height: weekHeight }}>
              {days.map((day) => <div key={day} className="relative border-l border-[var(--glass-divider)] last:border-r">
                {Array.from({ length: 36 }, (_, index) => {
                  const minuteOfDay = weekStartMin + index * 30;
                  const hour = Math.floor(minuteOfDay / 60);
                  const minute = minuteOfDay % 60 === 0 ? '00' : '30';
                  const id = `slot:${day}:${String(hour).padStart(2, '0')}:${minute}`;
                  return <DropTarget key={id} id={id} className="absolute right-0 left-0" style={{ top: index * (weekHeight / 36), height: weekHeight / 36 }} />;
                })}
                {layoutTimed(tasks, day).filter((block) => block.endMin > weekStartMin && block.startMin < 24 * 60).map((block) => <TimedTask key={block.id} block={{ ...block, startMin: Math.max(block.startMin, weekStartMin), endMin: Math.min(block.endMin, 24 * 60) }} compact scale={weekHeight / 18} origin={weekStartMin} busy={busy} onOpen={onOpen} onToggle={onToggle} />)}
                <NowLine dateKey={day} today={today} scale={weekHeight / 18} origin={weekStartMin} height={weekHeight} />
              </div>)}
            </div>
          </div></div>}
          {mode === 'month' && <div>
            <div className="grid grid-cols-7 py-2 text-center text-xs text-muted-foreground">{['一', '二', '三', '四', '五', '六', '日'].map((label) => <div key={label}>{label}</div>)}</div>
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const items = tasks.filter((task) => scheduleDateKey(task) === day).sort((a, b) => (a.scheduledStart ?? '9').localeCompare(b.scheduledStart ?? '9'));
                const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
                return <DropTarget key={day} id={`cell:${day}`} className={cn('min-h-[112px] border-t border-l border-[var(--glass-divider)] p-1.5 [&:nth-child(7n)]:border-r', !inMonth && 'opacity-50')} onClick={() => { setAnchor(day); setMode('day'); }}>
                  <div className={cn('mb-1 text-sm', day === today && 'grid size-6 place-items-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]')}>{Number(day.slice(8))}</div>
                  {items.slice(0, 3).map((task) => <DragTask key={task.id} task={task}><div className="mb-0.5 flex h-6 items-center gap-1 truncate rounded-md px-1.5 text-[11px]"><span className="w-[3px] self-stretch rounded-full" style={{ background: priorityColor(task.priority) }} />{task.scheduledStart && <span className="tabular-nums text-muted-foreground">{formatTime(task.scheduledStart)} </span>}<span className="truncate">{task.title}</span></div></DragTask>)}
                  {items.length > 3 && <div className="text-[11px] text-muted-foreground">+{items.length - 3}</div>}
                </DropTarget>;
              })}
            </div>
          </div>}
        </div>
        <aside className="glass-subtle max-h-64 overflow-y-auto rounded-2xl p-2 lg:max-h-none">
          <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">未安排<span className="tabular-nums">{tray.length}</span></div>
          {!tray.length && <p className="py-8 text-center text-sm text-muted-foreground">没有待安排的任务</p>}
          {tray.map((task, index) => {
            const overdue = Boolean(task.dueDate && task.dueDate < today);
            const previous = tray[index - 1];
            const showOverdue = overdue && !(previous?.dueDate && previous.dueDate < today);
            return <div key={task.id}>
              {showOverdue && <p className="px-2 pt-1 text-xs text-[var(--destructive)]">逾期</p>}
              <DragTask task={task}><div data-testid="tray-item" className="flex h-10 cursor-grab items-center gap-2 rounded-lg px-2 text-sm hover:bg-[var(--glass-hover)]"><span className="h-4 w-[3px] rounded-full" style={{ background: priorityColor(task.priority) }} /><span className="truncate">{task.title}</span></div></DragTask>
            </div>;
          })}
        </aside>
      </div>}
    </div>
    <DragOverlay>{dragging && <div className="glass-control rounded-lg px-2 py-1 text-[13px] shadow-[var(--glass-shadow)]">{dragging.title}</div>}</DragOverlay>
  </DndContext>;
}
