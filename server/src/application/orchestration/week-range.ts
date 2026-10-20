import { DomainError } from '../../domain/task.js';

function assertZone(timeZone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23' }).format(new Date()); }
  catch { throw new DomainError('INVALID_TIME_ZONE', '时区无效', 400); }
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekdayIso: number };

function partsInZone(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  let hour = read('hour');
  if (hour === '24') hour = '00';
  const sundayBased = weekdays.indexOf(read('weekday'));
  const weekdayIso = sundayBased <= 0 ? 7 : sundayBased;
  return { year: Number(read('year')), month: Number(read('month')), day: Number(read('day')), hour: Number(hour), minute: Number(read('minute')), second: Number(read('second')), weekdayIso };
}

function offsetMinutes(instant: Date, timeZone: string) {
  const local = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** Local calendar date at 00:00 in `timeZone`, as a UTC instant. Retries once across a DST gap. */
function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = offsetMinutes(new Date(guess), timeZone);
  let utc = guess - offset * 60_000;
  const again = offsetMinutes(new Date(utc), timeZone);
  if (again !== offset) utc = guess - again * 60_000;
  return new Date(utc);
}

function addDays(year: number, month: number, day: number, days: number) {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** Monday 00:00 through the next Monday 00:00 in `timeZone`, shifted by whole weeks. Both ends are UTC instants. */
export function weekRange(now: Date, timeZone: string, offsetWeeks = 0) {
  assertZone(timeZone);
  const local = partsInZone(now, timeZone);
  const monday = addDays(local.year, local.month, local.day, -(local.weekdayIso - 1) + offsetWeeks * 7);
  const next = addDays(monday.year, monday.month, monday.day, 7);
  return {
    from: zonedMidnightToUtc(monday.year, monday.month, monday.day, timeZone).toISOString(),
    to: zonedMidnightToUtc(next.year, next.month, next.day, timeZone).toISOString(),
  };
}
