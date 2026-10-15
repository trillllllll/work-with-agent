import { DomainError } from '../domain/task.js';

export type Clock = { now: () => Date };

export type CurrentTimeResult = {
  utc: string;
  timeZone: string;
  timeZoneSource: 'argument' | 'context' | 'default';
  localDate: string;
  localTime: string;
  localDateTime: string;
  utcOffsetMinutes: number;
  weekdayIso: 1 | 2 | 3 | 4 | 5 | 6 | 7;
};

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23' }).format(new Date());
  } catch {
    throw new DomainError('INVALID_TIME_ZONE', '时区无效', 400);
  }
}

/** Format an instant in an IANA zone. The model cannot supply the current instant. */
export function getCurrentTime(
  args: { timeZone?: string },
  context: { timeZone?: string; timeZoneSource?: 'context' | 'default' },
  clock: Clock = { now: () => new Date() },
): CurrentTimeResult {
  let timeZone: string;
  let timeZoneSource: CurrentTimeResult['timeZoneSource'];
  if (args.timeZone) {
    timeZone = args.timeZone;
    timeZoneSource = 'argument';
  } else if (context.timeZone && context.timeZoneSource !== 'default') {
    timeZone = context.timeZone;
    timeZoneSource = 'context';
  } else {
    timeZone = 'Asia/Shanghai';
    timeZoneSource = 'default';
  }
  assertTimeZone(timeZone);
  const instant = clock.now();
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
  const localDate = `${read('year')}-${read('month')}-${read('day')}`;
  const localTime = `${hour}:${read('minute')}:${read('second')}`;
  const sundayBased = weekdays.indexOf(read('weekday')) + 1;
  const weekday = sundayBased === 1 ? 7 : Math.max(0, sundayBased - 1);
  const utcOffsetMinutes = Math.round((Date.UTC(Number(read('year')), Number(read('month')) - 1, Number(read('day')), Number(hour), Number(read('minute')), Number(read('second'))) - instant.getTime()) / 60000);
  return {
    utc: instant.toISOString(),
    timeZone,
    timeZoneSource,
    localDate,
    localTime,
    localDateTime: `${localDate}T${localTime}`,
    utcOffsetMinutes,
    weekdayIso: (weekday >= 1 && weekday <= 7 ? weekday : 1) as CurrentTimeResult['weekdayIso'],
  };
}
