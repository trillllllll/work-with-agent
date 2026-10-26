import { parseRecurrenceRule } from '../../../server/src/domain/recurrence.js';
import { t } from '../i18n/index.js';

/** UI presets map to canonical rule JSON; anything else is set through AI or sync. */
export const recurrencePresets = [
  { key: 'none', rule: '' },
  { key: 'daily', rule: '{"unit":"day","step":1}' },
  { key: 'weekly', rule: '{"unit":"week","step":1}' },
  { key: 'biweekly', rule: '{"unit":"week","step":2}' },
  { key: 'monthly', rule: '{"unit":"month","step":1}' },
] as const;

export function recurrenceLabel(value: string | null | undefined): string {
  if (!value) return t('tasks:recurrence.none');
  let rule: ReturnType<typeof parseRecurrenceRule> = null;
  try { rule = parseRecurrenceRule(value); } catch { rule = null; }
  if (!rule) return t('tasks:recurrence.invalid');
  if (rule.step === 1) return t(`tasks:recurrence.unit.${rule.unit}`);
  if (rule.unit === 'week' && rule.step === 2) return t('tasks:recurrence.biweekly');
  return t(`tasks:recurrence.every.${rule.unit}`, { step: rule.step });
}
