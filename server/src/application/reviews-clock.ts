import { DomainError } from '../domain/task.js';

export type Schedule = { frequency: string; timeOfDay: string; timeZone: string; weekDay: number };
const dayMs = 86_400_000;

export function validateSchedule(value: Schedule) {
  if (!['daily', 'weekly'].includes(value.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeOfDay) || !Number.isInteger(value.weekDay) || value.weekDay < 0 || value.weekDay > 6) throw new DomainError('INVALID_SCHEDULE', '回顾频率、当地时间或星期无效', 400);
  assertTimeZone(value.timeZone);
  return value;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached calendar formatter. Invalid IANA zones throw INVALID_TIME_ZONE. */
export function calendarFormatter(timeZone: string) {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    format.format(0);
    formatters.set(timeZone, format);
    return format;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_TIME_ZONE', '请选择有效的 IANA 时区', 400);
  }
}

export function assertTimeZone(timeZone: string) {
  calendarFormatter(timeZone);
}

function formatter(timeZone: string) {
  return calendarFormatter(timeZone);
}
function localParts(date: Date, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** `format()` is several times faster than `formatToParts`. Fall back when the string is not `YYYY-MM-DD…HH:mm`. */
export function localStamp(date: Date, format: Intl.DateTimeFormat) {
  const text = format.format(date);
  const match = /^(\d{4}-\d{2}-\d{2})\D+(\d{2}:\d{2})/.exec(text);
  if (match?.[1] && match[2]) return { date: match[1], time: match[2] };
  return localParts(date, format);
}

export function localCalendarDate(date: Date, timeZone: string, format = formatter(timeZone)) { return localStamp(date, format).date; }

/**
 * First instant of `nextDate` at local 00:00, walking forward from `start`
 * (the previous local midnight). A 24-hour step is accepted only when it lands
 * on that midnight, so a 23-hour or 25-hour civil day is not clipped to +24h.
 * A skipped midnight uses `scheduledInstant`.
 */
export function nextLocalMidnight(start: Date, nextDate: string, timeZone: string, format = formatter(timeZone)) {
  const plus = new Date(start.getTime() + dayMs);
  const plusStamp = localStamp(plus, format);
  if (plusStamp.date === nextDate && plusStamp.time === '00:00') return plus;
  const step = 60_000;
  let lo = Math.ceil((start.getTime() + 1) / step) * step;
  let hi = Math.floor((start.getTime() + 40 * 60 * 60 * 1000) / step) * step;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / step / 2) * step;
    const stamp = localStamp(new Date(mid), format);
    if (stamp.date < nextDate || (stamp.date === nextDate && stamp.time < '00:00')) lo = mid + step;
    else {
      if (stamp.date === nextDate && stamp.time === '00:00') found = mid;
      hi = mid - step;
    }
  }
  if (found != null) return new Date(found);
  return scheduledInstant(nextDate, '00:00', timeZone);
}
export function shiftCalendarDate(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10); }
const shiftDate = shiftCalendarDate;

/** Inclusive local calendar dates. `from` and `to` are `YYYY-MM-DD`. */
export function eachCalendarDate(from: string, to: string) {
  const days: string[] = [];
  for (let cursor = from; cursor <= to && days.length <= 400; cursor = shiftCalendarDate(cursor, 1)) days.push(cursor);
  return days;
}

/** Local dates touched by the half-open instant range `[fromMs, toMs)`. */
export function eachLocalDay(fromMs: number, toMs: number, timeZone: string) {
  if (!(toMs > fromMs)) return [];
  const format = formatter(timeZone);
  return eachCalendarDate(localCalendarDate(new Date(fromMs), timeZone, format), localCalendarDate(new Date(toMs - 1), timeZone, format));
}

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

/** The next wall-clock slot after `localDate`: one day later, or seven days for a weekly rule. */
export function followingOccurrence(schedule: Schedule, localDate: string) {
  validateSchedule(schedule);
  const date = shiftDate(localDate, schedule.frequency === 'daily' ? 1 : 7);
  const instant = scheduledInstant(date, schedule.timeOfDay, schedule.timeZone);
  return { key: `${schedule.frequency}:${date}`, scheduledAt: instant.toISOString(), localDate: date };
}
