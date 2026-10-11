import type { Task } from './api.js';
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
  const date = parseLocalDateTime(value);
  date.setMinutes(date.getMinutes() + minutes);
  return localDateTime(date);
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
export type TimedBlock = { id: string; startMin: number; endMin: number; lane: number; laneCount: number; task: Task };
/** 重叠分道：按簇分组，簇内按道排布，left = lane/laneCount，width = 1/laneCount */
export function layoutTimed(tasks: Task[], dateKey: string): TimedBlock[] {
  const blocks = tasks
    .filter((task) => task.scheduledStart && task.scheduledEnd && task.scheduledStart.slice(0, 10) === dateKey)
    .map((task) => ({ id: task.id, startMin: minutesOf(task.scheduledStart!), endMin: minutesOf(task.scheduledEnd!), lane: 0, laneCount: 1, task }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const lanes: number[] = []; // 每道当前占用到的 endMin
  for (const block of blocks) {
    const lane = lanes.findIndex((end) => end <= block.startMin);
    if (lane === -1) { lanes.push(block.endMin); block.lane = lanes.length - 1; }
    else { lanes[lane] = block.endMin; block.lane = lane; }
  }
  // 簇 = 连续重叠的块集合；簇内 laneCount = 用到的最大道 + 1
  let clusterStart = 0;
  for (let i = 0; i <= blocks.length; i++) {
    const cluster = blocks.slice(clusterStart, i);
    if (i < blocks.length) {
      const prev = blocks.slice(clusterStart, i);
      const maxEnd = prev.reduce((acc, block) => Math.max(acc, block.endMin), -1);
      if (!(blocks[i].startMin >= maxEnd && prev.length)) continue;
    }
    const laneCount = 1 + cluster.reduce((acc, block) => Math.max(acc, block.lane), 0);
    for (const block of cluster) block.laneCount = laneCount;
    clusterStart = i;
  }
  return blocks;
}

export function minutesBetween(start: string, end: string) {
  return Math.round((parseLocalDateTime(end).getTime() - parseLocalDateTime(start).getTime()) / 60000);
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
export function applyDrop(task: Pick<Task, 'scheduledStart' | 'scheduledEnd' | 'estimatedMinutes' | 'dueDate'>, target: string): SchedulePatch | null {
  const slot = /^slot:(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(target);
  if (slot) {
    const date = slot[1];
    const start = `${date}T${slot[2]}:${slot[3]}`;
    const end = task.scheduledStart && task.scheduledEnd
      ? addMinutes(start, minutesBetween(task.scheduledStart, task.scheduledEnd))
      : defaultEndFor(task, start);
    return { scheduledStart: start, scheduledEnd: end, dueDate: date };
  }
  const allday = /^allday:(\d{4}-\d{2}-\d{2})$/.exec(target);
  if (allday) return { dueDate: allday[1], scheduledStart: null, scheduledEnd: null };
  const day = /^(?:dayhead|cell):(\d{4}-\d{2}-\d{2})$/.exec(target);
  if (!day) return null;
  const date = day[1];
  if (task.scheduledStart && task.scheduledEnd) {
    const start = `${date}T${task.scheduledStart.slice(11, 16)}`;
    return { dueDate: date, scheduledStart: start, scheduledEnd: addMinutes(start, minutesBetween(task.scheduledStart, task.scheduledEnd)) };
  }
  return { dueDate: date };
}
