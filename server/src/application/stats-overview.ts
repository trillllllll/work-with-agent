/**
 * Owner stats overview. Four sections load independently: a failure becomes
 * `{ error }` on that section and the HTTP response stays 200.
 *
 * UTC instants (completedAt, createdAt, updatedAt, endedAt, lastUsedAt) are
 * filtered by the half-open bounds and bucketed with one cached formatter.
 * Wall-clock fields (focus startedAt/endedAt, task schedule) compare the
 * `YYYY-MM-DD` prefix and are never converted.
 *
 * ChangeRecord snapshots are never selected and taskActivity is never called.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { scheduleLastDate, shiftMinutes } from '../domain/schedule.js';
import { isCalendarDate } from './workspace-input.js';
import { calendarFormatter, eachCalendarDate, localCalendarDate, nextLocalMidnight, scheduledInstant, shiftCalendarDate } from './reviews-clock.js';
import { dispatchStats } from './orchestration/stats.js';

const dayMs = 86_400_000;
const maxDays = 366;
const heatDays = 14;

type Pair = { value: number; previous: number };
type Rate = { value: number | null; previous: number | null };
type ScheduleFields = { dueDate: string | null; scheduledStart: string | null; scheduledEnd: string | null };

export type OverviewRange = {
  from: string;
  to: string;
  tz: string;
  days: number;
  previous: { from: string; to: string };
  today: string;
  dates: string[];
  previousDates: string[];
  /** Inclusive instant of the previous window. */
  prevStart: Date;
  /** Inclusive instant of the current window. Also the exclusive end of the previous window. */
  start: Date;
  /** Exclusive instant of the current window. */
  end: Date;
  format: Intl.DateTimeFormat;
};

type PublicRange = {
  from: string;
  to: string;
  tz: string;
  days: number;
  previous: { from: string; to: string };
  today: string;
};

export type TasksSection = {
  completedByDay: Array<{ date: string; count: number; estimated: number }>;
  createdByDay: Array<{ date: string; count: number }>;
  created: Pair;
  completed: Pair;
  overdue: number;
  overdueTop: Array<{ id: string; title: string; topicId: string | null; topicName: string | null; topicColor: string | null; days: number }>;
  overdueOldestDays: number;
  byTopic: Array<{ topicId: string | null; name: string | null; color: string | null; count: number }>;
  byTag: Array<{ tagId: string; name: string; color: string; count: number }>;
  estimatedCount: Pair;
};

export type FocusSection = {
  minutesByDay: Array<{ date: string; minutes: number }>;
  sessionsByDay: Array<{ date: string; count: number }>;
  minutes: Pair;
  sessions: Pair;
  completedSessions: Pair;
  avgSession: Rate;
  completionRate: Rate;
  byTask: Array<{ taskId: string | null; title: string | null; minutes: number; sessions: number }>;
};

export type PlanSection = {
  byDay: Array<{ date: string; plannedTasks: number; plannedMinutes: number; doneOnPlan: number; doneLate: number; notDone: number; focusMinutes: number }>;
  /**
   * Unique tasks, not day-slots. A task is planned in a period when its schedule
   * covers any day of that period. It counts as on plan when it is done and the
   * completion's local date is on or before `scheduleLastDate`. `byDay` still
   * counts one slot per covered day, so those sums can disagree with this rate
   * (one 3-day on-plan task is 3/3 by day and 1/1 unique).
   */
  onPlanRate: Rate;
  plannedTasks: Pair;
  doneOnPlanTasks: Pair;
  plannedMinutesTotal: Pair;
  focusMinutesTotal: Pair;
  byBand: Array<{
    id: string | null;
    name: string | null;
    color: string | null;
    startMinute: number | null;
    endMinute: number | null;
    weekdays: number[] | null;
    plannedMinutes: number;
    focusMinutes: number;
  }>;
};

export type AiSection = {
  proposals: {
    created: Pair;
    executed: Pair;
    rejected: Pair;
    failed: Pair;
    pending: number;
    adoptionRate: Rate;
    bySource: Array<{ source: ProposalSource; count: number }>;
  };
  memories: {
    created: Pair;
    retired: Pair;
    byOrigin: { manual: number; ai: number };
    activeTotal: number;
  };
  autoMemory: { jobs: Pair; failed: Pair; adoption: Rate };
  dispatch: {
    rounds: Pair;
    firstPassRate: Rate;
    costMicroUsd: Pair;
    byDay: Awaited<ReturnType<typeof dispatchStats>>['byDay'];
  };
  connections: Array<{
    id: string;
    name: string;
    status: string;
    host: string;
    writes: number;
    proposals: number;
    lastActiveAt: string | null;
    byDay: Array<{ date: string; count: number }>;
  }>;
};

type ProposalSource = 'connection' | 'auto-memory' | 'local-owner' | 'builtin-agent' | 'orchestration-learning' | 'other';
type Period = 'current' | 'previous';
type SectionError = { error: { code: string; message: string } };

export type StatsOverviewDeps = {
  now?: Date;
  tasks?: (range: OverviewRange) => Promise<TasksSection>;
  focus?: (range: OverviewRange) => Promise<FocusSection>;
  plan?: (range: OverviewRange) => Promise<PlanSection>;
  ai?: (range: OverviewRange) => Promise<AiSection>;
};

export function parseOverviewQuery(query: { from?: string | null; to?: string | null; tz?: string | null }, now = new Date()): OverviewRange {
  const tz = typeof query.tz === 'string' ? query.tz.trim() : '';
  const from = typeof query.from === 'string' ? query.from.trim() : '';
  const to = typeof query.to === 'string' ? query.to.trim() : '';
  // Reuse the reviews clock: an empty or unknown zone is INVALID_TIME_ZONE.
  const format = calendarFormatter(tz);
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new DomainError('INVALID_STATS_RANGE', '统计区间无效', 400);
  const dates = eachCalendarDate(from, to);
  if (dates.length > maxDays) throw new DomainError('INVALID_STATS_RANGE', '统计区间无效', 400);
  const days = dates.length;
  const previous = { from: shiftCalendarDate(from, -days), to: shiftCalendarDate(from, -1) };
  const previousDates = eachCalendarDate(previous.from, previous.to);
  return {
    from,
    to,
    tz,
    days,
    previous,
    today: localCalendarDate(now, tz, format),
    dates,
    previousDates,
    prevStart: scheduledInstant(previous.from, '00:00', tz),
    start: scheduledInstant(from, '00:00', tz),
    end: scheduledInstant(shiftCalendarDate(to, 1), '00:00', tz),
    format,
  };
}

function publicRange(range: OverviewRange): PublicRange {
  return { from: range.from, to: range.to, tz: range.tz, days: range.days, previous: range.previous, today: range.today };
}

function pair(value: number, previous: number): Pair { return { value, previous }; }
function rate(value: number | null, previous: number | null): Rate { return { value, previous }; }
function fraction(part: number, whole: number): number | null { return whole === 0 ? null : part / whole; }

function periodOf(date: string | null, range: OverviewRange): Period | null {
  if (!date) return null;
  if (date >= range.from && date <= range.to) return 'current';
  if (date >= range.previous.from && date <= range.previous.to) return 'previous';
  return null;
}

function instantDate(iso: string | null | undefined, range: OverviewRange): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return localCalendarDate(new Date(ms), range.tz, range.format);
}

type DayBound = { date: string; startMs: number; endMs: number; startIso: string; endIso: string };

function num(value: unknown) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Half-open local midnights. `start` is the midnight of `dates[0]`. */
function boundsFor(start: Date, dates: string[], range: OverviewRange): DayBound[] {
  let cursor = start;
  const bounds: DayBound[] = [];
  for (let index = 0; index < dates.length; index += 1) {
    const nextDate = index + 1 < dates.length ? dates[index + 1]! : shiftCalendarDate(dates[index]!, 1);
    const end = nextLocalMidnight(cursor, nextDate, range.tz, range.format);
    bounds.push({ date: dates[index]!, startMs: cursor.getTime(), endMs: end.getTime(), startIso: cursor.toISOString(), endIso: end.toISOString() });
    cursor = end;
  }
  return bounds;
}

function slowBounds(dates: string[], range: OverviewRange): DayBound[] {
  return dates.map((date, index) => {
    const next = index + 1 < dates.length ? dates[index + 1]! : shiftCalendarDate(date, 1);
    const from = scheduledInstant(date, '00:00', range.tz);
    const to = scheduledInstant(next, '00:00', range.tz);
    return { date, startMs: from.getTime(), endMs: to.getTime(), startIso: from.toISOString(), endIso: to.toISOString() };
  });
}

/** Previous window through `to`. Falls back to per-day resolution if a civil day is not 24 hours and the walk drifts. */
function windowBounds(range: OverviewRange) {
  const dates = range.previousDates.concat(range.dates);
  const walked = boundsFor(range.prevStart, dates, range);
  const currentStart = walked[range.previousDates.length];
  const last = walked[walked.length - 1];
  const all = currentStart && last && currentStart.startMs === range.start.getTime() && last.endMs === range.end.getTime()
    ? walked
    : slowBounds(dates, range);
  return { all, current: all.slice(range.previousDates.length) };
}

function sliceBounds(bounds: DayBound[], from: string, to: string) {
  const start = bounds.findIndex((bound) => bound.date === from);
  const end = bounds.findIndex((bound) => bound.date === to);
  if (start < 0 || end < start) return null;
  return bounds.slice(start, end + 1);
}

/** Last 14 local days ending on `to`. Reuse the window walk when those days are already inside it. */
function heatWindow(range: OverviewRange, all: DayBound[]) {
  const heatFrom = shiftCalendarDate(range.to, -(heatDays - 1));
  const sliced = sliceBounds(all, heatFrom, range.to);
  if (sliced?.length === heatDays && sliced[sliced.length - 1]?.endMs === range.end.getTime()) return sliced;
  const dates = eachCalendarDate(heatFrom, range.to);
  const built = boundsFor(scheduledInstant(heatFrom, '00:00', range.tz), dates, range);
  return built[built.length - 1]?.endMs === range.end.getTime() ? built : slowBounds(dates, range);
}

/** Local date of an instant. Values inside `bounds` binary-search the midnights instead of formatting. */
function bucketDate(iso: string | null | undefined, bounds: DayBound[], range: OverviewRange) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const first = bounds[0];
  const last = bounds[bounds.length - 1];
  if (!first || !last || ms < first.startMs || ms >= last.endMs) return localCalendarDate(new Date(ms), range.tz, range.format);
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bound = bounds[mid]!;
    if (ms < bound.startMs) hi = mid - 1;
    else if (ms >= bound.endMs) lo = mid + 1;
    else return bound.date;
  }
  return localCalendarDate(new Date(ms), range.tz, range.format);
}

const createdAtCol = Prisma.raw('created_at');
const completedAtCol = Prisma.raw('completed_at');
const estimatedPredicate = Prisma.sql`completed_at_estimated = 1`;

function sumIn(column: Prisma.Sql, fromIso: string, toIso: string, predicate?: Prisma.Sql) {
  return predicate
    ? Prisma.sql`SUM(CASE WHEN ${column} >= ${fromIso} AND ${column} < ${toIso} AND (${predicate}) THEN 1 ELSE 0 END)`
    : Prisma.sql`SUM(CASE WHEN ${column} >= ${fromIso} AND ${column} < ${toIso} THEN 1 ELSE 0 END)`;
}

function wallDate(value: string | null | undefined): string | null {
  if (!value || value.length < 10) return null;
  const date = value.slice(0, 10);
  return isCalendarDate(date) ? date : null;
}

function calendarDaysBetween(earlier: string, later: string) {
  return Math.round((Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / dayMs);
}

function scheduleFirst(task: ScheduleFields) {
  return task.scheduledStart?.slice(0, 10) ?? task.dueDate;
}

function overlaps(first: string, last: string, from: string, to: string) {
  return first <= to && last >= from;
}

/** Both ends present. A start without an end is a point on that calendar day, not a block. */
function hasTimeBlock(task: ScheduleFields) {
  return Boolean(task.scheduledStart && task.scheduledEnd);
}

/**
 * Minutes of a block clipped to one local calendar day. The day ends at the next
 * midnight, so an end of exactly `T00:00` contributes nothing to that day.
 * Tasks without a block contribute `estimatedMinutes` once, on `scheduleLastDate`.
 */
function plannedMinutesOn(task: ScheduleFields & { estimatedMinutes: number | null }, date: string) {
  if (hasTimeBlock(task) && task.scheduledStart && task.scheduledEnd) {
    const dayStart = `${date}T00:00`;
    const dayEnd = `${shiftCalendarDate(date, 1)}T00:00`;
    const from = task.scheduledStart > dayStart ? task.scheduledStart : dayStart;
    const to = task.scheduledEnd < dayEnd ? task.scheduledEnd : dayEnd;
    if (to <= from) return 0;
    return Math.round((Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`)) / 60_000);
  }
  if (date === scheduleLastDate(task)) return task.estimatedMinutes ?? 0;
  return 0;
}

function daySegment(start: string, end: string, date: string) {
  const dayStart = `${date}T00:00`;
  const dayEnd = `${shiftCalendarDate(date, 1)}T00:00`;
  const from = start > dayStart ? start : dayStart;
  const to = end < dayEnd ? end : dayEnd;
  if (to <= from) return null;
  const startMinute = from === dayStart ? 0 : Number(from.slice(11, 13)) * 60 + Number(from.slice(14, 16));
  const endMinute = to === dayEnd ? 1440 : Number(to.slice(11, 13)) * 60 + Number(to.slice(14, 16));
  if (endMinute <= startMinute) return null;
  return { start: startMinute, end: endMinute };
}

function isoWeekday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function proposalSource(actorId: string): ProposalSource {
  if (actorId.startsWith('connection:')) return 'connection';
  if (actorId.startsWith('auto-memory:')) return 'auto-memory';
  if (actorId === 'local-owner') return 'local-owner';
  if (actorId === 'builtin-agent') return 'builtin-agent';
  if (actorId === 'orchestration-learning') return 'orchestration-learning';
  return 'other';
}

function latestInstant(values: Array<string | null | undefined>) {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best;
}

function bump(counts: { value: number; previous: number }, period: Period | null) {
  if (period === 'current') counts.value += 1;
  else if (period === 'previous') counts.previous += 1;
}

function sectionFailure(name: string, error: unknown): SectionError {
  console.error(`[stats-overview] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof DomainError) return { error: { code: error.code, message: error.message } };
  return { error: { code: 'STATS_SECTION_FAILED', message: '统计分区加载失败' } };
}

function settle<T>(name: string, result: PromiseSettledResult<T>): T | SectionError {
  return result.status === 'fulfilled' ? result.value : sectionFailure(name, result.reason);
}

export async function loadTasks(range: OverviewRange): Promise<TasksSection> {
  const { current } = windowBounds(range);
  const prevIso = range.prevStart.toISOString();
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();
  // Counts stay in SQLite. Shipping every created/completed row (and its tags) dominated the request.
  const createdSelect = [
    Prisma.sql`${sumIn(createdAtCol, prevIso, startIso)} AS previous`,
    Prisma.sql`${sumIn(createdAtCol, startIso, endIso)} AS current`,
    ...current.map((day, index) => Prisma.sql`${sumIn(createdAtCol, day.startIso, day.endIso)} AS ${Prisma.raw(`d${index}`)}`),
  ];
  const completedSelect = [
    Prisma.sql`${sumIn(completedAtCol, prevIso, startIso)} AS previous`,
    Prisma.sql`${sumIn(completedAtCol, startIso, endIso)} AS current`,
    Prisma.sql`${sumIn(completedAtCol, prevIso, startIso, estimatedPredicate)} AS estimatedPrevious`,
    Prisma.sql`${sumIn(completedAtCol, startIso, endIso, estimatedPredicate)} AS estimatedCurrent`,
    ...current.flatMap((day, index) => [
      Prisma.sql`${sumIn(completedAtCol, day.startIso, day.endIso)} AS ${Prisma.raw(`d${index}`)}`,
      Prisma.sql`${sumIn(completedAtCol, day.startIso, day.endIso, estimatedPredicate)} AS ${Prisma.raw(`e${index}`)}`,
    ]),
  ];
  const [createdRows, completedRows, topicRows, tagRows, openRows] = await Promise.all([
    prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.join(createdSelect)}
      FROM tasks
      WHERE deleted_at IS NULL AND created_at >= ${prevIso} AND created_at < ${endIso}
    `),
    prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.join(completedSelect)}
      FROM tasks
      WHERE deleted_at IS NULL AND status = 'done' AND completed_at >= ${prevIso} AND completed_at < ${endIso}
    `),
    prisma.$queryRaw<Array<{ topicId: string | null; name: string | null; color: string | null; count: unknown }>>(Prisma.sql`
      SELECT t.topic_id AS topicId, tp.name AS name, tp.color AS color, COUNT(*) AS count
      FROM tasks t
      LEFT JOIN topics tp ON tp.id = t.topic_id
      WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.completed_at >= ${startIso} AND t.completed_at < ${endIso}
      GROUP BY t.topic_id
    `),
    prisma.$queryRaw<Array<{ tagId: string; name: string; color: string; count: unknown }>>(Prisma.sql`
      SELECT tg.id AS tagId, tg.name AS name, tg.color AS color, COUNT(*) AS count
      FROM tasks t
      INNER JOIN task_tags tt ON tt.task_id = t.id
      INNER JOIN tags tg ON tg.id = tt.tag_id
      WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.completed_at >= ${startIso} AND t.completed_at < ${endIso}
      GROUP BY tg.id
    `),
    prisma.$queryRaw<Array<{ id: string; title: string; topicId: string | null; dueDate: string | null; scheduledStart: string | null; scheduledEnd: string | null; topicName: string | null; topicColor: string | null }>>`
      SELECT t.id AS id, t.title AS title, t.topic_id AS topicId, t.due_date AS dueDate,
             t.scheduled_start AS scheduledStart, t.scheduled_end AS scheduledEnd,
             tp.name AS topicName, tp.color AS topicColor
      FROM tasks t
      LEFT JOIN topics tp ON tp.id = t.topic_id
      WHERE t.deleted_at IS NULL AND t.status != 'done' AND (t.topic_id IS NULL OR tp.archived_at IS NULL)
    `,
  ]);
  const createdCounts = createdRows[0] ?? {};
  const completedCounts = completedRows[0] ?? {};
  const overdueRows = openRows.flatMap((row) => {
    const last = scheduleLastDate(row);
    if (!last || last >= range.today) return [];
    return [{ id: row.id, title: row.title, topicId: row.topicId, topicName: row.topicName, topicColor: row.topicColor, days: calendarDaysBetween(last, range.today) }];
  }).sort((left, right) => right.days - left.days || left.id.localeCompare(right.id));

  return {
    completedByDay: current.map((day, index) => ({ date: day.date, count: num(completedCounts[`d${index}`]), estimated: num(completedCounts[`e${index}`]) })),
    createdByDay: current.map((day, index) => ({ date: day.date, count: num(createdCounts[`d${index}`]) })),
    created: pair(num(createdCounts.current), num(createdCounts.previous)),
    completed: pair(num(completedCounts.current), num(completedCounts.previous)),
    overdue: overdueRows.length,
    overdueTop: overdueRows.slice(0, 5),
    overdueOldestDays: overdueRows[0]?.days ?? 0,
    byTopic: topicRows
      .map((row) => ({ topicId: row.topicId, name: row.name, color: row.color, count: num(row.count) }))
      .sort((left, right) => right.count - left.count || (left.topicId ?? '').localeCompare(right.topicId ?? '')),
    byTag: tagRows
      .map((row) => ({ tagId: row.tagId, name: row.name, color: row.color, count: num(row.count) }))
      .sort((left, right) => right.count - left.count || left.tagId.localeCompare(right.tagId)),
    estimatedCount: pair(num(completedCounts.estimatedCurrent), num(completedCounts.estimatedPrevious)),
  };
}

type FocusRow = { taskId: string | null; startedAt: string; endedAt: string; durationMinutes: number; completed: boolean; task: { title: string } | null };

export async function loadFocus(range: OverviewRange): Promise<FocusSection> {
  const rows = await focusRows(range);
  const minutesByDay = new Map(range.dates.map((date) => [date, { date, minutes: 0 }]));
  const sessionsByDay = new Map(range.dates.map((date) => [date, { date, count: 0 }]));
  const minutes = { value: 0, previous: 0 };
  const sessions = { value: 0, previous: 0 };
  const completedSessions = { value: 0, previous: 0 };
  const tasks = new Map<string, { taskId: string | null; title: string | null; minutes: number; sessions: number }>();

  for (const row of rows) {
    const date = wallDate(row.startedAt);
    const period = periodOf(date, range);
    if (!period) continue;
    if (period === 'current') {
      minutes.value += row.durationMinutes;
      sessions.value += 1;
      if (row.completed) completedSessions.value += 1;
      if (date) {
        minutesByDay.get(date)!.minutes += row.durationMinutes;
        sessionsByDay.get(date)!.count += 1;
      }
      const key = row.taskId ?? '';
      const task = tasks.get(key) ?? { taskId: row.taskId, title: row.taskId ? row.task?.title ?? null : null, minutes: 0, sessions: 0 };
      task.minutes += row.durationMinutes;
      task.sessions += 1;
      tasks.set(key, task);
    } else {
      minutes.previous += row.durationMinutes;
      sessions.previous += 1;
      if (row.completed) completedSessions.previous += 1;
    }
  }

  return {
    minutesByDay: [...minutesByDay.values()],
    sessionsByDay: [...sessionsByDay.values()],
    minutes,
    sessions,
    completedSessions,
    avgSession: rate(fraction(minutes.value, sessions.value), fraction(minutes.previous, sessions.previous)),
    completionRate: rate(fraction(completedSessions.value, sessions.value), fraction(completedSessions.previous, sessions.previous)),
    byTask: [...tasks.values()].sort((left, right) => right.minutes - left.minutes || right.sessions - left.sessions || (left.taskId ?? '').localeCompare(right.taskId ?? '')).slice(0, 5),
  };
}

/** Wall-clock window that can touch either period. The whole session stays on its start date. */
function focusWindow(range: OverviewRange) {
  return { gte: `${shiftCalendarDate(range.previous.from, -1)}T00:00`, lt: `${shiftCalendarDate(range.to, 1)}T00:00` };
}

async function focusRows(range: OverviewRange): Promise<FocusRow[]> {
  const window = focusWindow(range);
  return prisma.focusSession.findMany({
    where: { kind: 'focus', startedAt: { gte: window.gte, lt: window.lt } },
    select: { taskId: true, startedAt: true, endedAt: true, durationMinutes: true, completed: true, task: { select: { title: true } } },
  });
}

type Band = { id: string; name: string; color: string; startMinute: number; endMinute: number; weekdays: number[]; position: number };
type BandTotals = { plannedMinutes: number; focusMinutes: number };

export async function loadPlan(range: OverviewRange): Promise<PlanSection> {
  const windowStart = `${range.previous.from}T00:00`;
  const windowEnd = `${shiftCalendarDate(range.to, 1)}T00:00`;
  const { all } = windowBounds(range);
  const focus = focusWindow(range);
  const [taskRows, bandRows, sessions] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; status: string; dueDate: string | null; estimatedMinutes: number | bigint | null; scheduledStart: string | null; scheduledEnd: string | null; completedAt: string | null }>>`
      SELECT id, status, due_date AS dueDate, estimated_minutes AS estimatedMinutes,
             scheduled_start AS scheduledStart, scheduled_end AS scheduledEnd, completed_at AS completedAt
      FROM tasks
      WHERE deleted_at IS NULL AND (
        (scheduled_start IS NULL AND due_date >= ${range.previous.from} AND due_date <= ${range.to})
        OR (scheduled_start >= ${windowStart} AND scheduled_start < ${windowEnd})
        OR (scheduled_start < ${windowStart} AND scheduled_end > ${windowStart})
      )
    `,
    prisma.planTimeBand.findMany({ orderBy: { position: 'asc' } }),
    prisma.focusSession.findMany({
      where: { kind: 'focus', startedAt: { gte: focus.gte, lt: focus.lt } },
      select: { startedAt: true, endedAt: true, durationMinutes: true },
    }),
  ]);
  const tasks = taskRows.map((row) => ({ ...row, estimatedMinutes: row.estimatedMinutes == null ? null : num(row.estimatedMinutes) }));
  const bands: Band[] = bandRows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    weekdays: JSON.parse(row.weekdaysJson) as number[],
    position: row.position,
  }));
  const bandTotals = new Map<string, BandTotals>(bands.map((band) => [band.id, { plannedMinutes: 0, focusMinutes: 0 }]));
  const ungrouped: BandTotals = { plannedMinutes: 0, focusMinutes: 0 };
  const byDay = new Map(range.dates.map((date) => [date, { date, plannedTasks: 0, plannedMinutes: 0, doneOnPlan: 0, doneLate: 0, notDone: 0, focusMinutes: 0 }]));
  const unique = { current: { planned: 0, done: 0 }, previous: { planned: 0, done: 0 } };
  let plannedMinutesCurrent = 0;
  let plannedMinutesPrevious = 0;

  const addSegment = (date: string, segment: { start: number; end: number }, field: keyof BandTotals) => {
    const weekday = isoWeekday(date);
    const covered: Array<[number, number]> = [];
    for (const band of bands) {
      if (!band.weekdays.includes(weekday)) continue;
      const from = Math.max(segment.start, band.startMinute);
      const to = Math.min(segment.end, band.endMinute);
      if (to <= from) continue;
      bandTotals.get(band.id)![field] += to - from;
      covered.push([from, to]);
    }
    covered.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let used = 0;
    let open = -1;
    let close = -1;
    for (const [from, to] of covered) {
      if (open < 0) { open = from; close = to; continue; }
      if (from <= close) close = Math.max(close, to);
      else { used += close - open; open = from; close = to; }
    }
    if (open >= 0) used += close - open;
    const rest = segment.end - segment.start - used;
    if (rest > 0) ungrouped[field] += rest;
  };

  for (const task of tasks) {
    const first = scheduleFirst(task);
    const last = scheduleLastDate(task);
    if (!first || !last) continue;
    const completion = task.status === 'done' ? bucketDate(task.completedAt, all, range) : null;
    const outcome = task.status === 'done' && completion && completion <= last ? 'doneOnPlan' : task.status === 'done' && completion && completion > last ? 'doneLate' : 'notDone';
    if (overlaps(first, last, range.previous.from, range.previous.to)) {
      unique.previous.planned += 1;
      if (outcome === 'doneOnPlan') unique.previous.done += 1;
    }
    if (overlaps(first, last, range.from, range.to)) {
      unique.current.planned += 1;
      if (outcome === 'doneOnPlan') unique.current.done += 1;
    }
    const walk = (from: string, to: string, onDay: (date: string) => void) => {
      if (from > to) return;
      for (let date = from, guard = 0; date <= to && guard < maxDays; date = shiftCalendarDate(date, 1), guard += 1) onDay(date);
    };
    walk(first > range.from ? first : range.from, last < range.to ? last : range.to, (date) => {
      const bucket = byDay.get(date);
      if (!bucket) return;
      const minutes = plannedMinutesOn(task, date);
      bucket.plannedTasks += 1;
      bucket.plannedMinutes += minutes;
      bucket[outcome] += 1;
      plannedMinutesCurrent += minutes;
      if (!hasTimeBlock(task) || !task.scheduledStart || !task.scheduledEnd) return;
      const segment = daySegment(task.scheduledStart, task.scheduledEnd, date);
      if (segment) addSegment(date, segment, 'plannedMinutes');
    });
    walk(first > range.previous.from ? first : range.previous.from, last < range.previous.to ? last : range.previous.to, (date) => {
      plannedMinutesPrevious += plannedMinutesOn(task, date);
    });
  }

  const focusMinutes = { value: 0, previous: 0 };
  for (const session of sessions) {
    const date = wallDate(session.startedAt);
    const period = periodOf(date, range);
    if (period === 'current' && date) {
      focusMinutes.value += session.durationMinutes;
      const bucket = byDay.get(date);
      if (bucket) bucket.focusMinutes += session.durationMinutes;
    } else if (period === 'previous') focusMinutes.previous += session.durationMinutes;
    // Band focus uses the clock overlap, which can cross midnight. byDay above
    // keeps the whole durationMinutes on the start date, so the two totals differ
    // when a session does not start and end on the same local day.
    if (!session.endedAt || session.endedAt <= session.startedAt) continue;
    const last = shiftMinutes(session.endedAt, -1).slice(0, 10);
    for (let date = session.startedAt.slice(0, 10), guard = 0; date <= last && date <= range.to && guard < 3; date = shiftCalendarDate(date, 1), guard += 1) {
      if (date < range.from) continue;
      const segment = daySegment(session.startedAt, session.endedAt, date);
      if (segment) addSegment(date, segment, 'focusMinutes');
    }
  }

  const byBand: PlanSection['byBand'] = bands.map((band) => {
    const totals = bandTotals.get(band.id)!;
    return { id: band.id, name: band.name, color: band.color, startMinute: band.startMinute, endMinute: band.endMinute, weekdays: band.weekdays, plannedMinutes: totals.plannedMinutes, focusMinutes: totals.focusMinutes };
  });
  if (ungrouped.plannedMinutes > 0 || ungrouped.focusMinutes > 0) {
    byBand.push({ id: null, name: null, color: null, startMinute: null, endMinute: null, weekdays: null, plannedMinutes: ungrouped.plannedMinutes, focusMinutes: ungrouped.focusMinutes });
  }

  return {
    byDay: [...byDay.values()],
    onPlanRate: rate(fraction(unique.current.done, unique.current.planned), fraction(unique.previous.done, unique.previous.planned)),
    plannedTasks: pair(unique.current.planned, unique.previous.planned),
    doneOnPlanTasks: pair(unique.current.done, unique.previous.done),
    plannedMinutesTotal: pair(plannedMinutesCurrent, plannedMinutesPrevious),
    focusMinutesTotal: focusMinutes,
    byBand,
  };
}

function proposalIdList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))];
  } catch {
    return [];
  }
}

export async function loadAi(range: OverviewRange): Promise<AiSection> {
  const gte = range.prevStart.toISOString();
  const lt = range.end.toISOString();
  const currentGte = range.start.toISOString();
  const { all } = windowBounds(range);
  const heat = heatWindow(range, all);
  const heatDates = heat.map((day) => day.date);
  const activityStart = new Date(Math.min(heat[0]?.startMs ?? range.start.getTime(), range.start.getTime())).toISOString();
  // One grouped index read. Selecting each ChangeRecord would pull snapshot blobs and then format every timestamp.
  const writeSelect = [
    Prisma.sql`connection_id AS connectionId`,
    Prisma.sql`${sumIn(createdAtCol, currentGte, lt)} AS writes`,
    ...heat.map((day, index) => Prisma.sql`${sumIn(createdAtCol, day.startIso, day.endIso)} AS ${Prisma.raw(`d${index}`)}`),
  ];

  const [proposalRows, pending, memoryRows, activeTotal, jobs, writeRows, connectionProposals, dispatchCurrent, dispatchPrevious] = await Promise.all([
    prisma.proposal.findMany({
      where: { OR: [{ createdAt: { gte, lt } }, { updatedAt: { gte, lt }, status: { in: ['executed', 'rejected', 'failed'] } }] },
      select: { id: true, actorId: true, status: true, createdAt: true, updatedAt: true },
    }),
    prisma.proposal.count({ where: { status: 'pending' } }),
    prisma.memory.findMany({
      where: { OR: [{ createdAt: { gte, lt } }, { status: 'retired', updatedAt: { gte, lt } }] },
      select: { origin: true, status: true, createdAt: true, updatedAt: true },
    }),
    prisma.memory.count({ where: { status: 'active' } }),
    prisma.autoMemoryJob.findMany({
      where: { createdAt: { gte, lt } },
      select: { status: true, proposalIds: true, createdAt: true },
    }),
    prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.join(writeSelect)}
      FROM change_records
      WHERE connection_id IS NOT NULL AND created_at >= ${activityStart} AND created_at < ${lt}
      GROUP BY connection_id
    `),
    prisma.proposal.findMany({
      where: { connectionId: { not: null }, createdAt: { gte: currentGte, lt } },
      select: { connectionId: true },
    }),
    dispatchStats({ from: currentGte, to: lt, tz: range.tz }),
    dispatchStats({ from: gte, to: currentGte, tz: range.tz }),
  ]);

  const created = { value: 0, previous: 0 };
  const executed = { value: 0, previous: 0 };
  const rejected = { value: 0, previous: 0 };
  const failed = { value: 0, previous: 0 };
  const sources = new Map<ProposalSource, number>();
  for (const row of proposalRows) {
    const createdPeriod = periodOf(instantDate(row.createdAt, range), range);
    bump(created, createdPeriod);
    if (createdPeriod === 'current') sources.set(proposalSource(row.actorId), (sources.get(proposalSource(row.actorId)) ?? 0) + 1);
    if (row.status !== 'executed' && row.status !== 'rejected' && row.status !== 'failed') continue;
    const updatedPeriod = periodOf(instantDate(row.updatedAt, range), range);
    if (row.status === 'executed') bump(executed, updatedPeriod);
    else if (row.status === 'rejected') bump(rejected, updatedPeriod);
    else bump(failed, updatedPeriod);
  }

  const memoriesCreated = { value: 0, previous: 0 };
  const retired = { value: 0, previous: 0 };
  const byOrigin = { manual: 0, ai: 0 };
  for (const row of memoryRows) {
    const createdPeriod = periodOf(instantDate(row.createdAt, range), range);
    bump(memoriesCreated, createdPeriod);
    if (createdPeriod === 'current') {
      if (row.origin === 'ai') byOrigin.ai += 1;
      else byOrigin.manual += 1;
    }
    if (row.status === 'retired') bump(retired, periodOf(instantDate(row.updatedAt, range), range));
  }

  const jobCounts = { value: 0, previous: 0 };
  const jobFailures = { value: 0, previous: 0 };
  const jobProposalIds = { current: new Set<string>(), previous: new Set<string>() };
  for (const job of jobs) {
    const period = periodOf(instantDate(job.createdAt, range), range);
    bump(jobCounts, period);
    if (job.status === 'failed') bump(jobFailures, period);
    if (!period) continue;
    for (const id of proposalIdList(job.proposalIds)) jobProposalIds[period].add(id);
  }
  const adoptionIds = [...jobProposalIds.current, ...jobProposalIds.previous];
  const adoptionRows = adoptionIds.length
    ? await prisma.proposal.findMany({ where: { id: { in: adoptionIds } }, select: { id: true, status: true } })
    : [];
  const adoptionStatus = new Map(adoptionRows.map((row) => [row.id, row.status]));
  const adoptionOf = (ids: Set<string>) => {
    let executedCount = 0;
    let rejectedCount = 0;
    for (const id of ids) {
      const status = adoptionStatus.get(id);
      if (status === 'executed') executedCount += 1;
      else if (status === 'rejected') rejectedCount += 1;
    }
    return fraction(executedCount, executedCount + rejectedCount);
  };

  const writesByConnection = new Map<string, number>();
  const heatByConnection = new Map<string, Map<string, number>>();
  for (const row of writeRows) {
    const connectionId = typeof row.connectionId === 'string' ? row.connectionId : null;
    if (!connectionId) continue;
    const writes = num(row.writes);
    // A heat-only write (before the current window) must not count as range activity.
    if (writes > 0) writesByConnection.set(connectionId, writes);
    const counts = new Map<string, number>();
    heat.forEach((day, index) => {
      const count = num(row[`d${index}`]);
      if (count > 0) counts.set(day.date, count);
    });
    if (counts.size) heatByConnection.set(connectionId, counts);
  }
  const proposalsByConnection = new Map<string, number>();
  for (const row of connectionProposals) {
    if (!row.connectionId) continue;
    proposalsByConnection.set(row.connectionId, (proposalsByConnection.get(row.connectionId) ?? 0) + 1);
  }

  const active = await prisma.connection.findMany({
    where: { status: 'active' },
    select: { id: true, name: true, status: true, host: true, lastUsedAt: true },
  });
  const activeIds = new Set(active.map((row) => row.id));
  const extraIds = [...new Set([...writesByConnection.keys(), ...proposalsByConnection.keys()])].filter((id) => !activeIds.has(id));
  const revoked = extraIds.length
    ? await prisma.connection.findMany({
      where: { id: { in: extraIds }, status: 'revoked' },
      select: { id: true, name: true, status: true, host: true, lastUsedAt: true },
    })
    : [];
  const listed = [...active, ...revoked];
  const listedIds = listed.map((row) => row.id);
  const [writeMax, proposalMax] = listedIds.length
    ? await Promise.all([
      prisma.changeRecord.groupBy({ by: ['connectionId'], where: { connectionId: { in: listedIds } }, _max: { createdAt: true } }),
      prisma.proposal.groupBy({ by: ['connectionId'], where: { connectionId: { in: listedIds } }, _max: { createdAt: true } }),
    ])
    : [[], []];
  const lastWrite = new Map(writeMax.flatMap((row) => row.connectionId ? [[row.connectionId, row._max.createdAt ?? null] as const] : []));
  const lastProposal = new Map(proposalMax.flatMap((row) => row.connectionId ? [[row.connectionId, row._max.createdAt ?? null] as const] : []));

  return {
    proposals: {
      created,
      executed,
      rejected,
      failed,
      pending,
      adoptionRate: rate(fraction(executed.value, executed.value + rejected.value), fraction(executed.previous, executed.previous + rejected.previous)),
      bySource: [...sources.entries()].map(([source, count]) => ({ source, count })).sort((left, right) => right.count - left.count || left.source.localeCompare(right.source)),
    },
    memories: { created: memoriesCreated, retired, byOrigin, activeTotal },
    autoMemory: { jobs: jobCounts, failed: jobFailures, adoption: rate(adoptionOf(jobProposalIds.current), adoptionOf(jobProposalIds.previous)) },
    dispatch: {
      rounds: pair(dispatchCurrent.roundCount, dispatchPrevious.roundCount),
      firstPassRate: rate(dispatchCurrent.firstPass.rate, dispatchPrevious.firstPass.rate),
      costMicroUsd: pair(dispatchCurrent.resources.costMicroUsd, dispatchPrevious.resources.costMicroUsd),
      byDay: dispatchCurrent.byDay,
    },
    connections: listed.map((row) => {
      const heat = heatByConnection.get(row.id);
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        host: row.host,
        writes: writesByConnection.get(row.id) ?? 0,
        proposals: proposalsByConnection.get(row.id) ?? 0,
        lastActiveAt: latestInstant([row.lastUsedAt, lastWrite.get(row.id), lastProposal.get(row.id)]),
        byDay: heatDates.map((date) => ({ date, count: heat?.get(date) ?? 0 })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  };
}

export async function statsOverview(query: { from: string; to: string; tz: string }, deps?: StatsOverviewDeps) {
  const range = parseOverviewQuery(query, deps?.now);
  const [tasks, focus, plan, ai] = await Promise.allSettled([
    (deps?.tasks ?? loadTasks)(range),
    (deps?.focus ?? loadFocus)(range),
    (deps?.plan ?? loadPlan)(range),
    (deps?.ai ?? loadAi)(range),
  ]);
  return { range: publicRange(range), tasks: settle('tasks', tasks), focus: settle('focus', focus), plan: settle('plan', plan), ai: settle('ai', ai) };
}
