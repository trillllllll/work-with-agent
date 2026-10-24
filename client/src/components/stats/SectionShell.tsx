import { Surface } from '@/components/ui/surface.js';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { compareDelta, splitDuration } from '@/lib/stats-range.js';

export type StatsNav = {
  go: (hash: string) => void;
  openTopic: (topicId: string | null) => void;
  openTask: (taskId: string) => void;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const dash = '—';

export function durationText(minutes: number, t: Translate): string {
  const split = splitDuration(minutes);
  return t(split.unit === 'hours' ? 'unit.hours' : 'unit.minutes', { value: split.value });
}

export function compactDuration(minutes: number, t: Translate): string {
  const split = splitDuration(minutes);
  return t(split.unit === 'hours' ? 'unit.hourCompact' : 'unit.minuteCompact', { value: split.value });
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <Surface as="div" tone="subtle" className={cn('glass-subtle min-w-0 rounded-xl border p-4', className)}>{children}</Surface>;
}

export function SectionFrame({ id, title, summary, link, children }: { id: 'tasks' | 'focus' | 'plan' | 'ai'; title: string; summary?: string; link?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section data-testid={`stats-section-${id}`} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {link && <Button variant="link" size="bare" type="button" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={link.onClick}>{link.label}</Button>}
      </div>
      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
      {children}
    </section>
  );
}

export function SectionError({ id, title, message, onRetry }: { id: 'tasks' | 'focus' | 'plan' | 'ai'; title: string; message: string; onRetry: () => void }) {
  const { t } = useTranslation('stats');
  return (
    <section data-testid={`stats-section-${id}`} className="min-w-0 space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Surface as="div" tone="subtle" role="alert" data-testid="stats-section-error" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <p className="text-sm text-destructive">{message || t('sectionError')}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
      </Surface>
    </section>
  );
}

export function ChartPlaceholder({ state }: { state: 'empty' | 'sparse' }) {
  const { t } = useTranslation('stats');
  return (
    <p className="flex h-40 items-center justify-center text-sm text-muted-foreground" data-testid={state === 'sparse' ? 'stats-sparse' : undefined}>
      {state === 'sparse' ? t('sparse') : t('section.noData')}
    </p>
  );
}

export function Delta({ current, previous }: { current: number | null; previous: number | null }) {
  const { t } = useTranslation('stats');
  const delta = compareDelta(current, previous);
  if (delta.direction === 'none') return <span className="text-xs text-muted-foreground">{t('delta.none')}</span>;
  if (delta.direction === 'flat') return <span className="text-xs text-muted-foreground">{t('delta.flat')}</span>;
  const up = delta.direction === 'up';
  return <span className={cn('text-xs', up ? 'text-success' : 'text-destructive')}>{t(up ? 'delta.up' : 'delta.down', { percent: delta.percent })}</span>;
}

export function Legend({ items }: { items: { label: string; color: string; swatch?: 'bar' | 'line' | 'hatch' }[] }) {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          {item.swatch === 'line' ? (
            <span className="inline-block h-0 w-4 border-t border-dashed" style={{ borderColor: item.color }} />
          ) : item.swatch === 'hatch' ? (
            <span className="inline-block size-2.5 rounded-sm" style={{ background: `repeating-linear-gradient(45deg, ${item.color}, ${item.color} 1px, transparent 1px, transparent 3px)` }} />
          ) : (
            <span className="inline-block size-2.5 rounded-sm" style={{ background: item.color }} />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
