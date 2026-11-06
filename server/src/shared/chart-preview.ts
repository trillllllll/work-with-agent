import type { ChartSpec } from '../agent/content-blocks.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 300) : '';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function prefix<T>(values: unknown, valid: (value: unknown) => value is T): T[] {
  if (!Array.isArray(values)) return [];
  const end = values.findIndex(value => !valid(value));
  return values.slice(0, Math.min(end < 0 ? values.length : end, 5000)) as T[];
}

/** Only complete JSON values reach this projection. Preview provenance is never verified. */
export function projectChartPreview(value: unknown, complete: (item: object) => boolean = () => true): ChartSpec | undefined {
  const raw = record(value);
  const common = { title: label(raw.title), unit: label(raw.unit), provenance: { kind: 'unverified' as const, label: label(record(raw.provenance).label) } };
  if (raw.kind === 'pie') {
    const values = prefix(raw.values, (item): item is { name: string; value: number } => {
      const row = record(item); return complete(row) && Object.keys(row).every(key => key === 'name' || key === 'value') && typeof row.name === 'string' && row.name.length <= 300 && finite(row.value) && row.value >= 0;
    }).map(row => ({ name: row.name, value: row.value }));
    return values.length ? { ...common, kind: 'pie', values } : undefined;
  }
  const rows = Array.isArray(raw.series) ? raw.series.slice(0, 10).map(record) : [];
  if (raw.kind === 'scatter') {
    const series = rows.filter(row => typeof row.name === 'string').map(row => ({ name: label(row.name), values: prefix(row.values, (item): item is [number, number] => Array.isArray(item) && complete(item) && item.length === 2 && item.every(finite)).map(pair => [...pair] as [number, number]) }));
    return series.some(row => row.values.length) && series.reduce((n, row) => n + row.values.length, 0) <= 5000 ? { ...common, kind: 'scatter', series } : undefined;
  }
  if (raw.kind !== 'bar' && raw.kind !== 'line') return;
  const categories = prefix(raw.categories, (item): item is string => typeof item === 'string' && item.length <= 300);
  const series = rows.filter(row => typeof row.name === 'string').map(row => ({ name: label(row.name), values: prefix(row.values, (item): item is number | null => item === null || finite(item)).slice(0, categories.length) }));
  const length = Math.max(0, ...series.map(row => row.values.length));
  return length && series.reduce((n, row) => n + row.values.length, 0) <= 5000 ? { ...common, kind: raw.kind, categories: categories.slice(0, length), series } : undefined;
}
