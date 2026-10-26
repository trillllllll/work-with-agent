import { DomainError } from './task.js';

export type RecurrenceUnit = 'day' | 'week' | 'month';
export type RecurrenceRule = { unit: RecurrenceUnit; step: number };
export const recurrenceUnits: readonly RecurrenceUnit[] = ['day', 'week', 'month'];

function shapeOf(value: unknown): RecurrenceRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { unit, step } = value as Record<string, unknown>;
  if (!recurrenceUnits.includes(unit as RecurrenceUnit)) return null;
  if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > 365) return null;
  return { unit: unit as RecurrenceUnit, step: step as number };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** Stored value is '' (no recurrence) or canonical JSON like {"unit":"week","step":1}. */
export function isRecurrenceRuleText(value: string): boolean {
  return value === '' || shapeOf(parseJson(value)) !== null;
}

/** Throws on malformed stored values so a corrupt row surfaces instead of silently stopping the chain. */
export function parseRecurrenceRule(value: string): RecurrenceRule | null {
  if (value === '') return null;
  const rule = shapeOf(parseJson(value));
  if (!rule) throw new DomainError('INVALID_INPUT', '重复规则无效', 400);
  return rule;
}

export function recurrenceRuleText(rule: RecurrenceRule | null): string {
  return rule ? JSON.stringify({ unit: rule.unit, step: rule.step }) : '';
}

/** Normalize arbitrary-but-valid JSON text (key order, whitespace) so sync diffs stay stable. */
export function canonicalRecurrenceRuleText(value: string): string {
  return value === '' ? '' : recurrenceRuleText(parseRecurrenceRule(value));
}

const dayMs = 86_400_000;
const dateMs = (value: string) => Date.parse(`${value}T00:00:00Z`);
const fromDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Server-local calendar date; dueDate is a floating local date, not a UTC instant. */
export function localCalendarToday(): string {
  return new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * Next occurrence anchor by the planned date, even if completed late: +step units.
 * Month steps clamp to the target month's last day (Jan 31 → Feb 28/29), and the
 * clamped date becomes the next anchor.
 */
export function nextRecurrenceDate(rule: RecurrenceRule, anchor: string): string {
  if (rule.unit === 'month') {
    const [year, month, day] = anchor.split('-').map(Number);
    const total = year * 12 + (month - 1) + rule.step;
    const nextYear = Math.floor(total / 12);
    const nextMonth = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  }
  return fromDate(dateMs(anchor) + rule.step * (rule.unit === 'week' ? 7 : 1) * dayMs);
}

/** Anchor for the next occurrence: the planned due/schedule date, else completion day. */
export function recurrenceAnchor(dueDate: string | null, scheduledStart: string | null, today = localCalendarToday()): string {
  return dueDate ?? scheduledStart?.slice(0, 10) ?? today;
}
