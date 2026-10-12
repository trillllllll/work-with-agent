import { DomainError } from './task.js';

export type Schedule = { dueDate: string | null; scheduledStart: string | null; scheduledEnd: string | null };
export type SchedulePatch = Partial<Schedule>;
export const emptySchedule: Schedule = { dueDate: null, scheduledStart: null, scheduledEnd: null };

// Stored times are floating local wall times, not UTC instants. UTC arithmetic
// here avoids the server's timezone/DST changing a user's calendar duration.
function civilTime(value: string) { return Date.parse(`${value}:00Z`); }
export function shiftMinutes(value: string, minutes: number) {
  return new Date(civilTime(value) + minutes * 60000).toISOString().slice(0, 16);
}
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message, 400); }
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== '0000'
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validateSchedule(value: Schedule): Schedule {
  if (value.dueDate !== null && !validDate(value.dueDate)) invalid('安排日期无效');
  for (const time of [value.scheduledStart, value.scheduledEnd]) {
    if (time !== null && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !validDate(time.slice(0, 10)))) invalid('安排时间无效');
  }
  if (value.scheduledEnd && !value.scheduledStart) invalid('结束时间不能脱离开始时间');
  if (value.scheduledStart && value.scheduledEnd && value.scheduledEnd <= value.scheduledStart) invalid('结束时间必须晚于开始时间');
  if (value.scheduledStart && value.dueDate !== value.scheduledStart.slice(0, 10)) invalid('安排日期必须与开始时间一致');
  return value;
}

/** Apply one scheduling intent against the current task, inside its write transaction. */
export function normalizeSchedule(base: Schedule, patch: SchedulePatch): Schedule {
  const next: Schedule = { dueDate: patch.dueDate === undefined ? base.dueDate : patch.dueDate, scheduledStart: patch.scheduledStart === undefined ? base.scheduledStart : patch.scheduledStart, scheduledEnd: patch.scheduledEnd === undefined ? base.scheduledEnd : patch.scheduledEnd };
  if (patch.dueDate === null) {
    if (patch.scheduledStart || patch.scheduledEnd) invalid('清除日期时不能同时设置具体时间');
    return { ...emptySchedule };
  }
  if (patch.scheduledStart !== undefined) {
    if (patch.scheduledStart === null) {
      if (patch.scheduledEnd) invalid('结束时间不能脱离开始时间');
      next.scheduledEnd = null;
    } else {
      const date = patch.scheduledStart.slice(0, 10);
      if (patch.dueDate !== undefined && patch.dueDate !== date) invalid('安排日期必须与开始时间一致');
      next.dueDate = date;
      if (patch.scheduledEnd === undefined && base.scheduledStart && base.scheduledEnd) {
        next.scheduledEnd = shiftMinutes(patch.scheduledStart, (civilTime(base.scheduledEnd) - civilTime(base.scheduledStart)) / 60000);
      }
    }
  } else if (patch.dueDate !== undefined && base.scheduledStart) {
    next.scheduledStart = `${patch.dueDate}T${base.scheduledStart.slice(11)}`;
    if (base.scheduledEnd && patch.scheduledEnd === undefined) {
      next.scheduledEnd = shiftMinutes(next.scheduledStart, (civilTime(base.scheduledEnd) - civilTime(base.scheduledStart)) / 60000);
    }
  }
  return validateSchedule(next);
}

/** Historical snapshots have no independent deadline: retain their actual calendar position. */
export function normalizeLegacySchedule(value: Schedule): Schedule {
  return validateSchedule({ dueDate: value.scheduledStart?.slice(0, 10) ?? value.dueDate, scheduledStart: value.scheduledStart, scheduledEnd: value.scheduledEnd });
}
export function scheduleLastDate(value: Schedule) {
  return value.scheduledEnd ? shiftMinutes(value.scheduledEnd, -1).slice(0, 10) : value.scheduledStart?.slice(0, 10) ?? value.dueDate;
}
