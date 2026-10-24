import { NativeSelect } from '@/components/ui/native-select.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/lib/api.js';
import { addDays, addMinutes, defaultEndFor, formatTime, minutesBetween, moveToDate, type SchedulePatch } from '@/lib/schedule.js';
import { localDate } from '@/lib/todo.js';
import { t as translate } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { ScheduleDatePicker, ScheduleTimePicker } from './SchedulePickers.js';

export type ScheduleValue = Pick<Task, 'dueDate' | 'scheduledStart' | 'scheduledEnd'>;
export const noSchedule: ScheduleValue = { dueDate: null, scheduledStart: null, scheduledEnd: null };
export function scheduleError(value: ScheduleValue) {
  if (value.scheduledEnd && (!value.scheduledStart || value.scheduledEnd <= value.scheduledStart)) return translate('tasks:schedule.endBeforeStart');
  return '';
}

/** Local form only: its parent owns Save/Cancel and submits all three fields atomically. */
export function ScheduleFields({ value, onChange, estimatedMinutes = null, disabled = false }: { value: ScheduleValue; onChange: (value: ScheduleValue) => void; estimatedMinutes?: number | null; disabled?: boolean }) {
  const { t } = useTranslation('tasks');
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
    <label className="block text-sm">{t('schedule.mode')}<NativeSelect aria-label={t('schedule.mode')} className="glass-control mt-1 h-9 w-full rounded-md px-2" value={mode} onChange={(event) => chooseMode(event.target.value)}>
      <option value="none">{t('schedule.noDate')}</option><option value="allday">{t('schedule.allDay')}</option><option value="point">{t('schedule.point')}</option><option value="range">{t('schedule.range')}</option>
    </NativeSelect></label>
    {mode !== 'none' && <>
      <div className="flex gap-2">{[{ key: 'today', days: 0 }, { key: 'tomorrow', days: 1 }, { key: 'nextWeek', days: 7 }].map(({ key, days }) => <Button key={key} type="button" variant="outline" size="sm" onClick={() => {
        const date = new Date(); date.setDate(date.getDate() + days);
        change(moveToDate(value, localDate(date)));
      }}>{t(`schedule.${key}`)}</Button>)}</div>
      <div className="text-sm">{t('schedule.date')}<ScheduleDatePicker label={t('schedule.date')} value={value.dueDate ?? ''} open={picker === 'date'} onOpenChange={openPicker('date')} onChange={(date) => change(moveToDate(value, date))} disabled={disabled} className="mt-1 w-full" /></div>
    </>}
    {(mode === 'point' || mode === 'range') && <div className="text-sm">{mode === 'point' ? t('schedule.time') : t('schedule.start')}<ScheduleTimePicker label={mode === 'point' ? t('schedule.time') : t('schedule.start')} value={formatTime(value.scheduledStart!)} open={picker === 'start'} onOpenChange={openPicker('start')} onChange={(hm) => chooseStart(`${value.scheduledStart!.slice(0, 10)}T${hm}`)} disabled={disabled} className="mt-1 w-full" /></div>}
    {mode === 'range' && value.scheduledEnd && <>
      <div className="text-sm">{t('schedule.end')}<div className="mt-1 flex gap-2"><ScheduleDatePicker label={t('schedule.endDate')} value={value.scheduledEnd.slice(0, 10)} open={picker === 'endDate'} onOpenChange={openPicker('endDate')} onChange={(date) => change({ scheduledEnd: `${date}T${formatTime(value.scheduledEnd!)}` })} disabled={disabled} className="w-[9.5rem] shrink-0" /><ScheduleTimePicker label={t('schedule.end')} value={formatTime(value.scheduledEnd)} open={picker === 'end'} onOpenChange={openPicker('end')} onChange={(hm) => change({ scheduledEnd: `${value.scheduledEnd!.slice(0, 10)}T${hm}` })} disabled={disabled} align="end" className="min-w-0 flex-1" /></div></div>
      <div className="space-y-2"><p className="text-sm">{t('schedule.duration')}</p><div className="flex gap-1">{[30, 60, 120].map((minutes) => <Button key={minutes} type="button" variant="outline" size="sm" aria-pressed={duration === minutes} onClick={() => change({ scheduledEnd: addMinutes(value.scheduledStart!, minutes) })}>{minutes === 30 ? t('shared.minuteCount', { count: minutes }) : t('schedule.hourCount', { count: minutes / 60 })}</Button>)}</div></div>
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="ghost" size="sm" onClick={() => change({ scheduledEnd: `${addDays(value.scheduledStart!.slice(0, 10), 1)}T${formatTime(value.scheduledEnd!)}` })}>{t('schedule.moveToNextDay')}</Button></p>}
    </>}
    {mode !== 'none' && <Button type="button" variant="ghost" size="sm" onClick={() => { setPicker(null); onChange({ ...noSchedule }); }}>{t('schedule.clear')}</Button>}
  </fieldset>;
}
