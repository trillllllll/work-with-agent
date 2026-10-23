/// <reference lib="es2022.intl" />
import type { Task } from '@/lib/api.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function tagInitial(name: string) {
  return graphemes.segment(name.trim())[Symbol.iterator]().next().value?.segment ?? '';
}

/** Widths are intrinsic measurements, independent of the currently rendered mode. */
export function fitInlineTags(width: number, title: number, metadata: number, full: number[], initials: number[], countWidth: (hidden: number) => number) {
  const gap = 5;
  const total = (items: number[]) => items.reduce((sum, item) => sum + item, 0) + Math.max(0, items.length - 1) * 3;
  const remaining = Math.max(0, width - metadata - (metadata ? gap : 0));
  if (!full.length) return { short: false, visible: 0 };
  if (title + total(full) + gap <= remaining) return { short: false, visible: full.length };
  // Keep a useful title even on narrow child rows; tags yield before the title does.
  const titleReserve = Math.min(title, Math.max(48, Math.min(160, remaining * .42)));
  const budget = Math.max(0, remaining - titleReserve - gap);
  if (total(initials) <= budget) return { short: true, visible: initials.length };
  for (let visible = initials.length - 1; visible >= 0; visible--) {
    if (total(initials.slice(0, visible)) + (visible ? 3 : 0) + countWidth(initials.length - visible) <= budget) return { short: true, visible };
  }
  return { short: true, visible: 0 };
}

export function inlineSchedule(task: Pick<Task, 'scheduledStart' | 'scheduledEnd' | 'dueDate'>, today: string) {
  const date = task.scheduledStart?.slice(0, 10) || task.dueDate;
  if (!date) return null;
  const shortDate = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const time = task.scheduledStart?.slice(11, 16);
  const crossDay = Boolean(task.scheduledEnd && task.scheduledEnd.slice(0, 10) !== date);
  return { dateTime: task.scheduledStart || date, label: `${date === today && time ? '' : shortDate}${time ? `${date === today ? '' : ' '}${time}` : ''}${crossDay ? ' ↗' : ''}` };
}
