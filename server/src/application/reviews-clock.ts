import { DomainError } from '../domain/task.js';

export type Schedule = { frequency: string; timeOfDay: string; timeZone: string; weekDay: number };
const dayMs = 86_400_000;

export function validateSchedule(value: Schedule) {
  if (!['daily', 'weekly'].includes(value.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeOfDay) || !Number.isInteger(value.weekDay) || value.weekDay < 0 || value.weekDay > 6) throw new DomainError('INVALID_SCHEDULE', '回顾频率、当地时间或星期无效', 400);
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date()); }
  catch { throw new DomainError('INVALID_TIME_ZONE', '请选择有效的 IANA 时区', 400); }
  return value;
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function localParts(date: Date, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function localCalendarDate(date: Date, timeZone: string) { return localParts(date, formatter(timeZone)).date; }
function shiftDate(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10); }

/** Resolve a wall time once: first fold occurrence; a skipped time advances to the next valid minute. */
export function scheduledInstant(date: string, time: string, timeZone: string) {
  const format = formatter(timeZone);
  const anchor = Date.parse(`${date}T${time}:00Z`);
  let next: Date | null = null;
  for (let minute = -18 * 60; minute <= 18 * 60; minute += 1) {
    const instant = new Date(anchor + minute * 60_000);
    const local = localParts(instant, format);
    if (local.date !== date) continue;
    if (local.time === time) return instant;
    if (local.time > time && !next) next = instant;
  }
  if (next) return next;
  throw new DomainError('INVALID_SCHEDULE', '该当地日期没有可运行时刻', 400);
}

export function latestOccurrence(schedule: Schedule, at = new Date()) {
  validateSchedule(schedule);
  let date = localCalendarDate(at, schedule.timeZone);
  if (schedule.frequency === 'weekly') {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    date = shiftDate(date, -((weekday - schedule.weekDay + 7) % 7));
  }
  let instant = scheduledInstant(date, schedule.timeOfDay, schedule.timeZone);
  if (instant > at) {
    date = shiftDate(date, schedule.frequency === 'daily' ? -1 : -7);
    instant = scheduledInstant(date, schedule.timeOfDay, schedule.timeZone);
  }
  return { key: `${schedule.frequency}:${date}`, scheduledAt: instant.toISOString(), localDate: date };
}
