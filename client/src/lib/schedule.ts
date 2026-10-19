import type { Task } from './api.js';
import { t } from '../i18n/index.js';
import { localDate } from './todo.js';

export function localDateTime(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${localDate(date)}T${hh}:${mm}`;
}
export function parseLocalDateTime(value: string) {
  const [date, time] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
export function addMinutes(value: string, minutes: number) {
  return new Date(Date.parse(`${value}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
}
/** 一天内的分钟偏移，如 14:30 → 870 */
export function minutesOf(value: string) {
  const [, time] = value.split('T');
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}
export function formatTime(value: string) {
  return value.slice(11); // 'HH:mm'
}
/** 任务落在哪一天：优先 scheduledStart 的日期，其次 dueDate，null 表示无归属 */
export function scheduleDateKey(task: Pick<Task, 'scheduledStart' | 'dueDate'>) {
  return task.scheduledStart ? task.scheduledStart.slice(0, 10) : task.dueDate ?? null;
}
export function defaultEndFor(task: Pick<Task, 'estimatedMinutes'>, start: string) {
  return addMinutes(start, task.estimatedMinutes ?? 60);
}
type Scheduled = Pick<Task, 'dueDate' | 'scheduledStart' | 'scheduledEnd'>;
export function scheduleLastDate(task: Scheduled) {
  return task.scheduledEnd ? addMinutes(task.scheduledEnd, -1).slice(0, 10) : scheduleDateKey(task);
}
export function occursOn(task: Scheduled, dateKey: string) {
  const first = scheduleDateKey(task);
  const last = scheduleLastDate(task);
  return Boolean(first && last && first <= dateKey && last >= dateKey);
}
export function isOverdue(task: Scheduled, today: string) {
  const last = scheduleLastDate(task);
  return Boolean(last && last < today);
}
export function scheduleLabel(task: Scheduled) {
  if (!task.scheduledStart) return task.dueDate ? t('plan:schedule.allDay', { date: task.dueDate }) : t('plan:schedule.unscheduled');
  const start = task.scheduledStart.replace('T', ' ');
  if (!task.scheduledEnd) return start;
  return `${start} — ${task.scheduledEnd.slice(0, 10) === task.scheduledStart.slice(0, 10) ? formatTime(task.scheduledEnd) : task.scheduledEnd.replace('T', ' ')}`;
}
export function shiftMonth(value: string, direction: number) {
  const [year, month, day] = value.split('-').map(Number);
  const target = new Date(year, month - 1 + direction, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return localDate(new Date(target.getFullYear(), target.getMonth(), Math.min(day, lastDay)));
}
export type TimedBlock = { id: string; startMin: number; endMin: number; lane: number; laneCount: number; task: Task; point: boolean; startsHere: boolean; endsHere: boolean };
/** Split ranges at midnight, then assign lanes using visible footprints (including point labels). */
export function layoutTimed(tasks: Task[], dateKey: string): TimedBlock[] {
  const from = `${dateKey}T00:00`;
  const until = `${addDays(dateKey, 1)}T00:00`;
  const blocks: TimedBlock[] = tasks.filter((task) => task.scheduledStart && occursOn(task, dateKey)).map((task) => ({
    id: `${task.id}:${dateKey}`, task, point: !task.scheduledEnd,
    startMin: task.scheduledStart! < from ? 0 : minutesOf(task.scheduledStart!),
    endMin: !task.scheduledEnd ? minutesOf(task.scheduledStart!) : task.scheduledEnd >= until ? 1440 : minutesOf(task.scheduledEnd),
    startsHere: task.scheduledStart! >= from, endsHere: Boolean(task.scheduledEnd && task.scheduledEnd <= until),
    lane: 0, laneCount: 1,
  })).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.id.localeCompare(b.id));
  let cluster: TimedBlock[] = [];
  let clusterEnd = -1;
  let lanes: number[] = [];
  const finish = () => { for (const block of cluster) block.laneCount = lanes.length; };
  for (const block of blocks) {
    if (block.startMin >= clusterEnd) { finish(); cluster = []; lanes = []; clusterEnd = -1; }
    const footprintEnd = Math.max(block.endMin, block.startMin + 30);
    const free = lanes.findIndex((end) => end <= block.startMin);
    block.lane = free < 0 ? lanes.length : free;
    lanes[block.lane] = footprintEnd;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, footprintEnd);
  }
  finish();
  return blocks;
}
export function minutesBetween(start: string, end: string) {
  return Math.round((Date.parse(`${end}:00Z`) - Date.parse(`${start}:00Z`)) / 60000);
}
export function addDays(value: string, days: number) {
  const date = parseLocalDateTime(`${value}T00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}
export function mondayOf(value: string) {
  const date = parseLocalDateTime(`${value}T00:00`);
  return addDays(value, -((date.getDay() + 6) % 7));
}
export function sundayOf(value: string) {
  const weekday = parseLocalDateTime(`${value}T00:00`).getDay();
  return addDays(value, weekday === 0 ? 0 : 7 - weekday);
}
export function monthRange(anchor: string): [string, string] {
  const date = parseLocalDateTime(`${anchor}T00:00`);
  const first = localDate(new Date(date.getFullYear(), date.getMonth(), 1));
  const last = localDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  const start = mondayOf(first);
  const end = sundayOf(last);
  const cap = addDays(start, 41);
  return [start, end > cap ? cap : end];
}
export function rangeOf(mode: 'day' | 'week' | 'month', anchor: string): [string, string] {
  if (mode === 'day') return [anchor, anchor];
  if (mode === 'week') {
    const start = mondayOf(anchor);
    return [start, addDays(start, 6)];
  }
  return monthRange(anchor);
}
export function eachDate(start: string, end: string) {
  const days: string[] = [];
  for (let cursor = start; cursor <= end && days.length < 42; cursor = addDays(cursor, 1)) days.push(cursor);
  return days;
}
export type SchedulePatch = { dueDate?: string | null; scheduledStart?: string | null; scheduledEnd?: string | null };
export function moveToDate(task: Scheduled, date: string): SchedulePatch {
  if (!task.scheduledStart) return { dueDate: date, scheduledStart: null, scheduledEnd: null };
  const start = `${date}T${formatTime(task.scheduledStart)}`;
  return { dueDate: date, scheduledStart: start, scheduledEnd: task.scheduledEnd ? addMinutes(start, minutesBetween(task.scheduledStart, task.scheduledEnd)) : null };
}
export function applyDrop(task: Pick<Task, 'scheduledStart' | 'scheduledEnd' | 'estimatedMinutes' | 'dueDate'>, target: string): SchedulePatch | null {
  if (target === 'unschedule') return { dueDate: null, scheduledStart: null, scheduledEnd: null };
  const slot = /^slot:(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(target);
  if (slot) {
    const start = `${slot[1]}T${slot[2]}:${slot[3]}`;
    const end = task.scheduledStart
      ? task.scheduledEnd ? addMinutes(start, minutesBetween(task.scheduledStart, task.scheduledEnd)) : null
      : defaultEndFor(task, start);
    return { scheduledStart: start, scheduledEnd: end, dueDate: slot[1] };
  }
  const allday = /^allday:(\d{4}-\d{2}-\d{2})$/.exec(target);
  if (allday) return { dueDate: allday[1], scheduledStart: null, scheduledEnd: null };
  const day = /^(?:dayhead|cell):(\d{4}-\d{2}-\d{2})$/.exec(target);
  return day ? moveToDate(task, day[1]) : null;
}
export function resizeSchedule(task: Scheduled, edge: 'start' | 'end', delta: number): SchedulePatch | null {
  if (!task.scheduledStart || !task.scheduledEnd) return null;
  const duration = minutesBetween(task.scheduledStart, task.scheduledEnd);
  const moving = edge === 'start' ? task.scheduledStart : task.scheduledEnd;
  const snapped = Math.round((minutesOf(moving) + delta) / 30) * 30 - minutesOf(moving);
  const latestStart = Math.floor((minutesOf(task.scheduledStart) + duration - 30) / 30) * 30 - minutesOf(task.scheduledStart);
  const earliestEnd = Math.ceil((minutesOf(task.scheduledEnd) + 30 - duration) / 30) * 30 - minutesOf(task.scheduledEnd);
  const start = edge === 'start' ? addMinutes(task.scheduledStart, Math.min(snapped, latestStart)) : task.scheduledStart;
  const end = edge === 'end' ? addMinutes(task.scheduledEnd, Math.max(snapped, earliestEnd)) : task.scheduledEnd;
  return { dueDate: start.slice(0, 10), scheduledStart: start, scheduledEnd: end };
}
