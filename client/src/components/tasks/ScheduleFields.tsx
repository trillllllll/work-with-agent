import { useState } from 'react';
import type { Task } from '@/lib/api.js';
import { addDays, addMinutes, defaultEndFor, formatTime, minutesBetween, moveToDate, type SchedulePatch } from '@/lib/schedule.js';
import { localDate } from '@/lib/todo.js';
import { Button } from '@/components/ui/button.js';
import { ScheduleDatePicker, ScheduleTimePicker } from './SchedulePickers.js';

export type ScheduleValue = Pick<Task, 'dueDate' | 'scheduledStart' | 'scheduledEnd'>;
export const noSchedule: ScheduleValue = { dueDate: null, scheduledStart: null, scheduledEnd: null };
export function scheduleError(value: ScheduleValue) {
  if (value.scheduledEnd && (!value.scheduledStart || value.scheduledEnd <= value.scheduledStart)) return '结束时间必须晚于开始时间';
  return '';
}

/** Local form only: its parent owns Save/Cancel and submits all three fields atomically. */
export function ScheduleFields({ value, onChange, estimatedMinutes = null, disabled = false }: { value: ScheduleValue; onChange: (value: ScheduleValue) => void; estimatedMinutes?: number | null; disabled?: boolean }) {
  const [picker, setPicker] = useState<string | null>(null);
  const mode = value.scheduledStart ? value.scheduledEnd ? 'range' : 'point' : value.dueDate ? 'allday' : 'none';
  const change = (patch: SchedulePatch) => onChange({ ...value, ...patch });
  const chooseMode = (next: string) => {
    setPicker(null);
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
  const openPicker = (name: string) => (next: boolean) => setPicker(next ? name : null);
  const error = scheduleError(value);
  const duration = value.scheduledStart && value.scheduledEnd ? minutesBetween(value.scheduledStart, value.scheduledEnd) : 0;
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    <label className="block text-sm">安排方式<select aria-label="安排方式" className="glass-control mt-1 h-9 w-full rounded-md px-2" value={mode} onChange={(event) => chooseMode(event.target.value)}>
      <option value="none">无日期</option><option value="allday">全天</option><option value="point">时间点</option><option value="range">时间段</option>
    </select></label>
    {mode !== 'none' && <>
      <div className="flex gap-2">{[{ text: '今天', days: 0 }, { text: '明天', days: 1 }, { text: '下周', days: 7 }].map(({ text, days }) => <Button key={text} type="button" variant="outline" size="sm" onClick={() => {
        const date = new Date(); date.setDate(date.getDate() + days);
        change(moveToDate(value, localDate(date)));
      }}>{text}</Button>)}</div>
      <div className="text-sm">安排日期<ScheduleDatePicker label="安排日期" value={value.dueDate ?? ''} open={picker === 'date'} onOpenChange={openPicker('date')} onChange={(date) => change(moveToDate(value, date))} disabled={disabled} className="mt-1 w-full" /></div>
    </>}
    {(mode === 'point' || mode === 'range') && <div className="text-sm">{mode === 'point' ? '时间' : '开始时间'}<ScheduleTimePicker label={mode === 'point' ? '时间' : '开始时间'} value={formatTime(value.scheduledStart!)} open={picker === 'start'} onOpenChange={openPicker('start')} onChange={(hm) => chooseStart(`${value.scheduledStart!.slice(0, 10)}T${hm}`)} disabled={disabled} className="mt-1 w-full" /></div>}
    {mode === 'range' && value.scheduledEnd && <>
      <div className="text-sm">结束时间<div className="mt-1 flex gap-2"><ScheduleDatePicker label="结束日期" value={value.scheduledEnd.slice(0, 10)} open={picker === 'endDate'} onOpenChange={openPicker('endDate')} onChange={(date) => change({ scheduledEnd: `${date}T${formatTime(value.scheduledEnd!)}` })} disabled={disabled} className="w-[9.5rem] shrink-0" /><ScheduleTimePicker label="结束时间" value={formatTime(value.scheduledEnd)} open={picker === 'end'} onOpenChange={openPicker('end')} onChange={(hm) => change({ scheduledEnd: `${value.scheduledEnd!.slice(0, 10)}T${hm}` })} disabled={disabled} align="end" className="min-w-0 flex-1" /></div></div>
      <div className="space-y-2"><p className="text-sm">持续时长</p><div className="flex gap-1">{[30, 60, 120].map((minutes) => <Button key={minutes} type="button" variant="outline" size="sm" aria-pressed={duration === minutes} onClick={() => change({ scheduledEnd: addMinutes(value.scheduledStart!, minutes) })}>{minutes === 30 ? '30分钟' : `${minutes / 60}小时`}</Button>)}</div></div>
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="ghost" size="sm" onClick={() => change({ scheduledEnd: `${addDays(value.scheduledStart!.slice(0, 10), 1)}T${formatTime(value.scheduledEnd!)}` })}>改到次日</Button></p>}
    </>}
    {mode !== 'none' && <Button type="button" variant="ghost" size="sm" onClick={() => { setPicker(null); onChange({ ...noSchedule }); }}>清除安排</Button>}
  </fieldset>;
}
