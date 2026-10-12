import type { Task } from '@/lib/api.js';
import { addMinutes, defaultEndFor, minutesBetween, moveToDate, type SchedulePatch } from '@/lib/schedule.js';
import { localDate } from '@/lib/todo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';

export type ScheduleValue = Pick<Task, 'dueDate' | 'scheduledStart' | 'scheduledEnd'>;
export const noSchedule: ScheduleValue = { dueDate: null, scheduledStart: null, scheduledEnd: null };
export function scheduleError(value: ScheduleValue) {
  if (value.scheduledEnd && (!value.scheduledStart || value.scheduledEnd <= value.scheduledStart)) return '结束时间必须晚于开始时间';
  return '';
}

/** Local form only: its parent owns Save/Cancel and submits all three fields atomically. */
export function ScheduleFields({ value, onChange, estimatedMinutes = null, disabled = false }: { value: ScheduleValue; onChange: (value: ScheduleValue) => void; estimatedMinutes?: number | null; disabled?: boolean }) {
  const mode = value.scheduledStart ? value.scheduledEnd ? 'range' : 'point' : value.dueDate ? 'allday' : 'none';
  const change = (patch: SchedulePatch) => onChange({ ...value, ...patch });
  const chooseMode = (next: string) => {
    if (next === 'none') return onChange({ ...noSchedule });
    const date = value.dueDate ?? localDate();
    if (next === 'allday') return onChange({ dueDate: date, scheduledStart: null, scheduledEnd: null });
    const start = value.scheduledStart ?? `${date}T09:00`;
    onChange({ dueDate: start.slice(0, 10), scheduledStart: start, scheduledEnd: next === 'range' ? value.scheduledEnd ?? defaultEndFor({ estimatedMinutes }, start) : null });
  };
  const chooseStart = (start: string) => {
    if (!start) return;
    const duration = value.scheduledStart && value.scheduledEnd ? minutesBetween(value.scheduledStart, value.scheduledEnd) : estimatedMinutes ?? 60;
    change({ dueDate: start.slice(0, 10), scheduledStart: start, scheduledEnd: mode === 'range' ? addMinutes(start, duration) : null });
  };
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    <label className="block text-sm">安排方式<select aria-label="安排方式" className="glass-control mt-1 h-9 w-full rounded-md px-2" value={mode} onChange={(event) => chooseMode(event.target.value)}>
      <option value="none">无日期</option><option value="allday">全天</option><option value="point">时间点</option><option value="range">时间段</option>
    </select></label>
    {mode !== 'none' && <>
      <div className="flex gap-2">{[{ text: '今天', days: 0 }, { text: '明天', days: 1 }, { text: '下周', days: 7 }].map(({ text, days }) => <Button key={text} type="button" variant="outline" size="sm" onClick={() => {
        const date = new Date(); date.setDate(date.getDate() + days);
        change(moveToDate(value, localDate(date)));
      }}>{text}</Button>)}</div>
      <label className="block text-sm">安排日期<Input className="mt-1 min-w-0" type="date" aria-label="安排日期" value={value.dueDate ?? ''} onChange={(event) => { if (event.target.value) change(moveToDate(value, event.target.value)); }} /></label>
    </>}
    {(mode === 'point' || mode === 'range') && <label className="block text-sm">{mode === 'point' ? '时间' : '开始时间'}<Input className="mt-1 min-w-0" type="datetime-local" aria-label="开始时间" value={value.scheduledStart ?? ''} onChange={(event) => chooseStart(event.target.value)} /></label>}
    {mode === 'range' && <>
      <label className="block text-sm">结束时间<Input className="mt-1 min-w-0" type="datetime-local" aria-label="结束时间" value={value.scheduledEnd ?? ''} onChange={(event) => { if (event.target.value) change({ scheduledEnd: event.target.value }); }} /></label>
      <div className="space-y-2"><p className="text-sm">持续时长</p><div className="flex gap-1">{[30, 60, 120].map((minutes) => <Button key={minutes} type="button" variant="outline" size="sm" onClick={() => change({ scheduledEnd: addMinutes(value.scheduledStart!, minutes) })}>{minutes === 30 ? '30分钟' : `${minutes / 60}小时`}</Button>)}</div></div>
      {scheduleError(value) && <p role="alert" className="text-sm text-destructive">{scheduleError(value)}</p>}
    </>}
    {mode !== 'none' && <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...noSchedule })}>清除安排</Button>}
  </fieldset>;
}
