import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { intlLocale, t as translate } from '../../i18n/index.js';

export const memoryKindKeys = ['fact', 'decision', 'constraint', 'learning', 'question', 'crystal'] as const;
export const originKeys = ['manual', 'ai', 'mcp'] as const;
export const entityKindKeys = ['concept', 'person', 'tool', 'project', 'other'] as const;
const relationKeys = ['evidence', 'crystallized_from', 'label', 'mentions', 'attached', 'produced', 'related', 'about', 'contrasts'] as const;

function known(keys: readonly string[], value?: string | null): value is string {
  return Boolean(value && keys.includes(value));
}

export function memoryKindLabel(kind?: string | null) {
  if (known(memoryKindKeys, kind)) return translate(`knowledge:memoryView.kinds.${kind}`);
  return kind || translate('knowledge:memoryView.kinds.fallback');
}

export function originLabel(origin?: string | null) {
  if (known(originKeys, origin)) return translate(`knowledge:memoryView.origins.${origin}`);
  return translate('knowledge:memoryView.origins.manual');
}

export function entityKindLabel(kind?: string | null) {
  if (known(entityKindKeys, kind)) return translate(`knowledge:memoryView.entityKinds.${kind}`);
  return kind ?? '';
}

export function isEntityKind(kind?: string | null) {
  return known(entityKindKeys, kind);
}

export function relationLabel(relation: string) {
  if (known(relationKeys, relation)) return translate(`knowledge:memoryView.relations.${relation}`);
  return relation;
}

export type MemoryCardData = { id: string; title: string; content?: string; excerpt?: string; kind?: string; importance?: number; labels?: unknown; origin?: string; status?: string; health?: string; revision?: number; createdAt?: string; updatedAt?: string };

export function asLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value !== 'string' || !value.trim()) return [];
  try { return asLabels(JSON.parse(value)); } catch { return []; }
}

export function relativeTime(iso?: string) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return translate('knowledge:memoryView.relative.justNow');
  if (minutes < 60) return translate('knowledge:memoryView.relative.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return translate('knowledge:memoryView.relative.hours', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return translate('knowledge:memoryView.relative.days', { count: days });
  return new Date(iso).toLocaleDateString(intlLocale());
}

export function memoryExcerpt(memory: MemoryCardData) {
  return (memory.content || memory.excerpt || '').replace(/\s+/g, ' ').trim();
}

export function Stars({ value = 3, onChange }: { value?: number; onChange?: (value: number) => void }) {
  const { t } = useTranslation('knowledge');
  const stars = [1, 2, 3, 4, 5];
  if (!onChange) return <span aria-label={t('memoryView.stars.value', { value, max: 5 })} className="text-amber-500">{stars.map((star) => star <= value ? '★' : '☆').join('')}</span>;
  return <div role="radiogroup" aria-label={t('memoryView.stars.group')} className="flex gap-1">{stars.map((star) => <Button variant="plain" size="bare" key={star} type="button" role="radio" aria-checked={value === star} aria-label={t('memoryView.stars.star', { count: star })} className={`text-lg leading-none ${star <= value ? 'text-amber-500' : 'text-muted-foreground'}`} onClick={() => onChange(star)}>{star <= value ? '★' : '☆'}</Button>)}</div>;
}

export function MemorySummary({ memory, selected, onSelect }: { memory: MemoryCardData; selected?: boolean; onSelect?: () => void }) {
  const { t } = useTranslation('knowledge');
  const labels = asLabels(memory.labels);
  const excerpt = memoryExcerpt(memory);
  const status = memory.status === 'superseded' ? t('memoryView.status.superseded') : memory.status && memory.status !== 'active' ? t('memoryView.status.history') : '';
  return <Button variant="row" size="bare" type="button" onClick={onSelect} className={`w-full rounded-xl text-left ${selected ? 'ring-1 ring-primary/40' : ''}`} aria-pressed={selected}>
    <span className="flex flex-wrap items-start justify-between gap-3">
      <strong className="text-sm">{memory.title}</strong>
      <Stars value={memory.importance ?? 3} />
    </span>
    {excerpt && <span className="mt-2 line-clamp-2 block text-sm text-muted-foreground">{excerpt}</span>}
    <span className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{memoryKindLabel(memory.kind)}</span>
      <span>{t('memoryView.originTime', { origin: originLabel(memory.origin), time: relativeTime(memory.updatedAt || memory.createdAt) })}</span>
      {memory.health && memory.health !== 'current' && <span>{t('memoryView.reviewSource')}</span>}
      {status && <span>{status}</span>}
      {labels.map((label) => <span key={label} className="rounded-full border px-2 py-0.5">{label}</span>)}
    </span>
  </Button>;
}
