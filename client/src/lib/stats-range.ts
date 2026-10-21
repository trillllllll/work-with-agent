/** Local-calendar ranges for the stats overview. Dates are `YYYY-MM-DD` in the browser zone. */

export const MAX_STATS_DAYS = 366;

export type StatsRangeMode = '7d' | '30d' | 'custom';

export type ResolvedStatsRange = {
  mode: StatsRangeMode;
  from: string;
  to: string;
  /** False when a custom query is missing or out of bounds. Presets are always valid. */
  valid: boolean;
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

export function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

/** Inclusive day count. Invalid or reversed input returns 0. */
export function inclusiveDays(from: string, to: string): number {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return 0;
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const start = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const end = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((end - start) / 86_400_000) + 1;
}

export function isValidRange(from: string, to: string): boolean {
  const days = inclusiveDays(from, to);
  return days > 0 && days <= MAX_STATS_DAYS;
}

export function eachDate(from: string, to: string): string[] {
  const count = inclusiveDays(from, to);
  if (count === 0 || count > MAX_STATS_DAYS) return [];
  return Array.from({ length: count }, (_, index) => addDays(from, index));
}

/** `days` includes today. */
export function presetRange(days: 7 | 30, today = new Date()): { from: string; to: string } {
  const to = localDate(today);
  return { from: addDays(to, 1 - days), to };
}

/** The previous window of the same length, ending the day before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } | null {
  const days = inclusiveDays(from, to);
  if (days === 0) return null;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

export function weekdayKey(iso: string): WeekdayKey {
  const [year, month, day] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(year, month - 1, day).getDay()];
}

export function shortMonthDay(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${Number(month)}/${Number(day)}`;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function resolveStatsRange(query: { range?: string; from?: string; to?: string }, today = new Date()): ResolvedStatsRange {
  if (query.range === '30d') return { mode: '30d', ...presetRange(30, today), valid: true };
  if (query.range === 'custom') {
    const from = query.from ?? '';
    const to = query.to ?? '';
    return { mode: 'custom', from, to, valid: isValidRange(from, to) };
  }
  return { mode: '7d', ...presetRange(7, today), valid: true };
}

export type DeltaDirection = 'up' | 'down' | 'flat' | 'none';

export type Delta = { direction: DeltaDirection; percent: number };

/** Percent change versus the previous window. A zero or missing baseline cannot be a percentage. */
export function compareDelta(current: number | null, previous: number | null): Delta {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return { direction: 'none', percent: 0 };
  }
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (percent > 0) return { direction: 'up', percent };
  if (percent < 0) return { direction: 'down', percent: Math.abs(percent) };
  return { direction: 'flat', percent: 0 };
}

export function activeCount(values: readonly number[]): number {
  return values.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
}

/** A trend needs 5 points and at least 3 days that are not zero. */
export function isSparse(values: readonly number[]): boolean {
  if (values.length < 5) return true;
  return activeCount(values) < 3;
}

export type ChartState = 'empty' | 'sparse' | 'ready';

export function chartState(values: readonly number[]): ChartState {
  if (activeCount(values) === 0) return 'empty';
  return isSparse(values) ? 'sparse' : 'ready';
}

/** Day-by-day sum. A day counts as active when the sum is above zero. */
export function combineActivity(series: readonly (readonly number[])[]): number[] {
  const length = series.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length }, (_, index) => series.reduce((sum, row) => sum + Math.max(0, row[index] ?? 0), 0));
}

export function splitDuration(minutes: number): { value: string; unit: 'hours' | 'minutes' } {
  const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  if (safe < 60) return { value: String(Math.round(safe)), unit: 'minutes' };
  const hours = Math.round((safe / 60) * 10) / 10;
  return { value: Number.isInteger(hours) ? String(hours) : hours.toFixed(1), unit: 'hours' };
}

export function percentNumber(rate: number | null | undefined): number | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return Math.round(rate * 100);
}

export function formatUsd(micro: number): string {
  if (!Number.isFinite(micro)) return '—';
  const usd = micro / 1_000_000;
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function isSectionError(value: object): value is { error: { code: string; message: string } } {
  if (!('error' in value)) return false;
  const error = (value as { error?: { code?: unknown; message?: unknown } }).error;
  return !!error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string';
}
