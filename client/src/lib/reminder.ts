import { t } from '../i18n/index.js';

/**
 * Reminder tiers stored on each task. `null` follows the workspace default set in settings,
 * `-1` opts out, `0` fires at the start time, a positive number fires that many minutes early.
 * The values mirror REMINDER_LEAD_CHOICES on the server; anything else can arrive via sync.
 */
export const reminderPresets = [
  { key: 'follow', value: null },
  { key: 'off', value: -1 },
  { key: 'atTime', value: 0 },
  { key: 'before5', value: 5 },
  { key: 'before10', value: 10 },
  { key: 'before30', value: 30 },
  { key: 'before1h', value: 60 },
  { key: 'before1d', value: 1440 },
  { key: 'before30d', value: 43200 },
] as const;

function reminderText(value: number | null | undefined): string {
  if (value === null || value === undefined) return t('tasks:reminder.follow');
  if (value === -1) return t('tasks:reminder.off');
  if (value === 0) return t('tasks:reminder.atTime');
  if (value % 1440 === 0) return t('tasks:reminder.dayCount', { count: value / 1440 });
  return t('tasks:reminder.minuteCount', { count: value });
}

/** Row label: unknown values fall back to the raw tier so sync data never renders empty. */
export function reminderLabel(value: number | null | undefined): string {
  const known = reminderPresets.some((preset) => preset.value === value);
  return known ? reminderText(value) : value === undefined ? reminderText(null) : t('tasks:reminder.minuteCount', { count: value });
}
