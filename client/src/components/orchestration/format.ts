import { intlLocale, t } from '../../i18n/index.js';

function record(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function formatMissing() {
  return t('orchestration:history.missing');
}

/** Whole seconds, composed from locale unit strings so the client source stays free of translated text. */
export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return formatMissing();
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(t('orchestration:history.durationUnits.h', { n: hours }));
  if (minutes) parts.push(t('orchestration:history.durationUnits.m', { n: minutes }));
  if (seconds || !parts.length) parts.push(t('orchestration:history.durationUnits.s', { n: seconds }));
  return parts.join('');
}

export function formatTokens(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return formatMissing();
  return new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatCost(micro: number | null | undefined) {
  if (micro == null || !Number.isFinite(micro)) return formatMissing();
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

export function formatDiff(files: number | null | undefined, added: number | null | undefined, deleted: number | null | undefined) {
  if (files == null && added == null && deleted == null) return formatMissing();
  return t('orchestration:history.diff', {
    added: added ?? 0,
    deleted: deleted ?? 0,
    files: t('orchestration:history.files', { n: files ?? 0 }),
  });
}

export function jobDurationMs(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Checks live at result.result.result.checks on a job DTO (the report wrapper around the run result). */
export function readJobChecks(job: { result?: unknown }) {
  const root = record(job.result);
  const run = record(root?.result) ?? root;
  const inner = record(run?.result);
  const checks = inner?.checks;
  if (!Array.isArray(checks)) return [];
  const parsed: Array<{ name: string; passed: boolean }> = [];
  for (const item of checks) {
    const row = record(item);
    if (!row || typeof row.name !== 'string' || typeof row.passed !== 'boolean') continue;
    parsed.push({ name: row.name, passed: row.passed });
  }
  return parsed;
}
