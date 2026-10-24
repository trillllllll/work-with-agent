import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localDate } from '@/lib/todo.js';
import { shiftMonth } from '@/lib/schedule.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';

const ROW = 36;
const WEEK_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function keepSchedulePickerOpen(event: { target: EventTarget | null; preventDefault(): void; detail?: { originalEvent?: Event } }) {
  const candidate = event.detail?.originalEvent?.target ?? event.target;
  const element = candidate instanceof Element ? candidate : candidate instanceof Node ? candidate.parentElement : null;
  if (element?.closest('[data-schedule-picker]')) event.preventDefault();
}

function pad(value: number) { return String(value).padStart(2, '0'); }
function showDate(value: string) { return value.replace(/-/g, '/'); }
function gearPath(teeth: number, inner: number, outer: number) {
  const points: string[] = [];
  for (let index = 0; index < teeth; index += 1) {
    const base = (index / teeth) * Math.PI * 2 - Math.PI / 2;
    const span = (Math.PI * 2) / teeth;
    [0.08, 0.3, 0.7, 0.92].forEach((step, stepIndex) => {
      const angle = base + span * step;
      const radius = stepIndex === 1 || stepIndex === 2 ? outer : inner;
      points.push(`${points.length ? 'L' : 'M'}${ (Math.cos(angle) * radius).toFixed(2) } ${ (Math.sin(angle) * radius).toFixed(2) }`);
    });
  }
  return `${points.join(' ')} Z`;
}
const mainGear = gearPath(12, 18, 27);
const pinionGear = gearPath(8, 10, 16);

function monthCells(viewMonth: string) {
  const [year, month] = viewMonth.split('-').map(Number);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const count = new Date(year, month, 0).getDate();
  const previousCount = new Date(year, month - 1, 0).getDate();
  const cells: { iso: string; day: number; outside: boolean }[] = [];
  for (let index = 0; index < firstDow; index += 1) {
    const day = previousCount - firstDow + 1 + index;
    cells.push({ iso: localDate(new Date(year, month - 2, day)), day, outside: true });
  }
  for (let day = 1; day <= count; day += 1) cells.push({ iso: localDate(new Date(year, month - 1, day)), day, outside: false });
  let cursor = 1;
  while (cells.length < 42) {
    cells.push({ iso: localDate(new Date(year, month, cursor)), day: cursor, outside: true });
    cursor += 1;
  }
  return cells;
}

function GearPair({ rotation }: { rotation: number }) {
  const gradientId = useId().replace(/:/g, '');
  return <div className="relative h-[78px] w-[62px] shrink-0" aria-hidden>
    <svg className="absolute top-1.5 left-0 size-[54px]" style={{ transform: `rotate(${rotation}deg)` }} viewBox="-32 -32 64 64">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f4f4f5" /><stop offset="0.42" stopColor="#9a9aa1" /><stop offset="1" stopColor="#3a3a3e" /></linearGradient></defs>
      <path fill={`url(#${gradientId})`} fillRule="evenodd" d={`${mainGear} M -6 0 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0`} />
      <rect x="-7" y="-1.1" width="14" height="2.2" rx="0.4" fill="#111" />
    </svg>
    <svg className="absolute right-0 bottom-0.5 size-[30px]" style={{ transform: `rotate(${-rotation * 1.5}deg)` }} viewBox="-20 -20 40 40">
      <path fill={`url(#${gradientId})`} fillRule="evenodd" d={`${pinionGear} M -3.5 0 a 3.5 3.5 0 1 0 7 0 a 3.5 3.5 0 1 0 -7 0`} />
    </svg>
  </div>;
}

function Wheel({ kind, selected, onSelect }: { kind: 'hour' | 'minute'; selected: string; onSelect: (value: string) => void }) {
  const { t } = useTranslation('tasks');
  const ref = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  const timer = useRef(0);
  const [scrollTop, setScrollTop] = useState(() => Number(selected) * ROW);
  selectedRef.current = selected;
  onSelectRef.current = onSelect;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const top = Number(selected) * ROW;
    if (Math.abs(node.scrollTop - top) > 1) node.scrollTop = top;
    setScrollTop(top);
  }, [selected]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const count = kind === 'hour' ? 24 : 60;
  const hot = Math.min(count - 1, Math.max(0, Math.round(scrollTop / ROW)));
  return <div className="grid min-w-0 grid-cols-[62px_minmax(0,1fr)] items-center gap-0.5 rounded-xl border border-border bg-foreground/[0.05] p-1.5 shadow-[inset_0_1px_0_var(--glass-highlight)]">
    <GearPair rotation={(scrollTop / ROW) * 30} />
    <div className="relative h-[180px] min-w-0">
      <div ref={ref} className="h-[180px] touch-pan-y snap-y snap-mandatory overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ paddingBlock: 72, scrollPaddingBlock: 72 }} onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setScrollTop(top);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          const node = ref.current;
          if (!node) return;
          const next = pad(Math.min(count - 1, Math.max(0, Math.round(node.scrollTop / ROW))));
          if (next !== selectedRef.current) onSelectRef.current(next);
        }, 90);
      }}>
        {Array.from({ length: count }, (_, index) => {
          const value = pad(index);
          const on = index === hot;
          return <Button variant="row" size="bare" key={value} type="button" aria-label={t(kind === 'hour' ? 'schedule.hourOption' : 'schedule.minuteOption', { value })} aria-selected={value === selected} className={`block h-[36px] w-full snap-center bg-transparent text-center tabular-nums ${on ? 'text-xl font-semibold text-foreground' : index % 5 === 0 || kind === 'hour' ? 'text-foreground/75' : 'text-muted-foreground'}`} onClick={() => onSelect(value)}>{value}</Button>;
        })}
      </div>
      <span className="pointer-events-none absolute inset-y-2.5 left-0 w-1.5 text-foreground/40 bg-[repeating-linear-gradient(180deg,transparent_0_4px,currentColor_4px_5px,transparent_5px_10px)]" />
      <span className="pointer-events-none absolute inset-y-2.5 right-0 w-1.5 text-foreground/40 bg-[repeating-linear-gradient(180deg,transparent_0_4px,currentColor_4px_5px,transparent_5px_10px)]" />
      <span className="pointer-events-none absolute inset-x-0.5 top-1/2 h-[36px] -translate-y-1/2 rounded-lg border border-foreground/25 bg-foreground/10" />
    </div>
  </div>;
}

export function ScheduleDatePicker({ label, value, open, onOpenChange, onChange, disabled = false, className = '' }: { label: string; value: string; open: boolean; onOpenChange: (open: boolean) => void; onChange: (date: string) => void; disabled?: boolean; className?: string }) {
  const { t } = useTranslation('tasks');
  const { t: plan } = useTranslation('plan');
  const [viewMonth, setViewMonth] = useState(value.slice(0, 7));
  useEffect(() => { if (open && value) setViewMonth(value.slice(0, 7)); }, [open, value]);
  useEffect(() => { if (disabled && open) onOpenChange(false); }, [disabled, open, onOpenChange]);
  const [year, month] = viewMonth.split('-');
  const today = localDate();
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild><Button variant="input" size="bare" type="button" aria-label={label} disabled={disabled} className={`glass-control flex h-10 items-center justify-between rounded-md px-3 text-left ${className}`}>{value ? showDate(value) : t('schedule.pickDate')}<span className="text-muted-foreground">{t('schedule.calendar')}</span></Button></PopoverTrigger>
    <PopoverContent data-task-editor data-schedule-picker aria-label={t('schedule.pickDate')} align="start" collisionPadding={12} className="z-[80] w-64 p-3" onPointerDown={(event) => event.stopPropagation()} onOpenAutoFocus={(event) => event.preventDefault()}>
      <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm font-medium">{t('schedule.monthLabel', { year, month: Number(month) })}</p><span className="flex gap-1"><Button type="button" variant="outline" size="sm" aria-label={t('schedule.prevMonth')} disabled={disabled} onClick={() => setViewMonth(shiftMonth(`${viewMonth}-01`, -1).slice(0, 7))}>‹</Button><Button type="button" variant="outline" size="sm" aria-label={t('schedule.nextMonth')} disabled={disabled} onClick={() => setViewMonth(shiftMonth(`${viewMonth}-01`, 1).slice(0, 7))}>›</Button><Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('schedule.done')}</Button></span></div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">{WEEK_IDS.map((day) => <span key={day} className="grid h-8 place-items-center text-muted-foreground">{plan(`weekday.${day}.narrow`)}</span>)}{monthCells(viewMonth).map((cell) => <Button variant="plain" size="bare" key={cell.iso} type="button" disabled={disabled} aria-label={cell.iso} aria-selected={cell.iso === value} className={`grid h-8 place-items-center rounded-full ${cell.iso === value ? 'bg-primary font-semibold text-primary-foreground' : cell.iso === today ? 'text-foreground ring-1 ring-muted-foreground' : cell.outside ? 'text-muted-foreground' : 'text-foreground'}`} onClick={() => { onChange(cell.iso); onOpenChange(false); }}>{cell.day}</Button>)}</div>
    </PopoverContent>
  </Popover>;
}

export function ScheduleTimePicker({ label, value, open, onOpenChange, onChange, disabled = false, align = 'start', className = '' }: { label: string; value: string; open: boolean; onOpenChange: (open: boolean) => void; onChange: (hm: string) => void; disabled?: boolean; align?: 'start' | 'end'; className?: string }) {
  const { t } = useTranslation('tasks');
  const [part, setPart] = useState<'hour' | 'minute'>('minute');
  useEffect(() => { if (disabled && open) onOpenChange(false); }, [disabled, open, onOpenChange]);
  const [hour, minute] = value.split(':');
  const choose = (nextHour: string, nextMinute: string) => onChange(`${nextHour}:${nextMinute}`);
  const presets = [{ key: 'now', label: t('schedule.now'), next: 'now' }, { key: '09:00', label: '09:00', next: '09:00' }, { key: '14:00', label: '14:00', next: '14:00' }, { key: '18:00', label: '18:00', next: '18:00' }];
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild><Button variant="input" size="bare" type="button" aria-label={label} disabled={disabled} className={`glass-control flex h-10 items-center rounded-md px-3 text-left tabular-nums ${className}`} onClick={(event) => { const node = event.target instanceof Element ? event.target.closest('[data-part]') : null; if (node instanceof HTMLElement && (node.dataset.part === 'hour' || node.dataset.part === 'minute')) setPart(node.dataset.part); }}><span data-part="hour" className={`rounded px-0.5 ${open && part === 'hour' ? 'bg-foreground/15' : ''}`}>{hour}</span><span className="text-muted-foreground">:</span><span data-part="minute" className={`rounded px-0.5 ${open && part === 'minute' ? 'bg-foreground/15' : ''}`}>{minute}</span></Button></PopoverTrigger>
    <PopoverContent data-task-editor data-schedule-picker aria-label={t('schedule.pickTime')} align={align} collisionPadding={12} className="z-[80] w-auto max-w-[calc(100vw-1.5rem)] p-3" style={{ width: align === 'end' ? 'min(20.5rem, calc(100vw - 1.5rem))' : 'min(20.5rem, var(--radix-popover-trigger-width), calc(100vw - 1.5rem))' }} onPointerDown={(event) => event.stopPropagation()} onOpenAutoFocus={(event) => event.preventDefault()}>
      <div className="mb-2 flex items-center justify-between"><p className="text-sm text-muted-foreground">{t('schedule.time')}</p><Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('schedule.done')}</Button></div>
      <div className="mb-2 flex flex-wrap gap-1">{presets.map((preset) => <Button key={preset.key} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { if (preset.next === 'now') { const date = new Date(); choose(pad(date.getHours()), pad(date.getMinutes())); } else choose(preset.next.slice(0, 2), preset.next.slice(3)); }}>{preset.label}</Button>)}</div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Wheel kind="hour" selected={hour} onSelect={(next) => { if (disabled) return; setPart('hour'); choose(next, minute); }} />
        <Wheel kind="minute" selected={minute} onSelect={(next) => { if (disabled) return; setPart('minute'); choose(hour, next); }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('schedule.gearHint')}</p>
    </PopoverContent>
  </Popover>;
}
