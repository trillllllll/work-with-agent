import { NativeSelect } from '@/components/ui/native-select.js';
import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewBatch, ReviewRule } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { formatInZone, needsAttention } from '@/lib/review-format.js';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';

const statusKey: Record<ReviewBatch['status'], string> = {
  ready: 'reviews.statusReady',
  partial: 'reviews.statusPartial',
  failed: 'reviews.statusFailed',
  generating: 'reviews.statusGenerating',
};

const statusClass: Record<ReviewBatch['status'], string> = {
  ready: 'border-success-border bg-success-bg text-success',
  partial: 'border-warning-border bg-warning-bg text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  generating: 'border-border bg-muted text-foreground',
};

function stamp(iso: string, locale: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try { return formatInZone(iso, locale); }
  catch { return iso; }
}

function coverage(batch: ReviewBatch, locale: string, label: (from: string, through: string) => string) {
  const from = batch.snapshot.from;
  const through = batch.snapshot.through;
  if (typeof from !== 'string' || typeof through !== 'string') return '';
  return label(stamp(from, locale), stamp(through, locale));
}

export type RunningRuleRow = { id: string; name: string; startedAt: string };

type ReviewRecordListProps = {
  rules: ReviewRule[];
  batches: ReviewBatch[];
  ruleId: string;
  selectedId: string;
  runningRules: RunningRuleRow[];
  onRuleChange: (ruleId: string | null) => void;
  onOpen: (batchId: string) => void;
};

export function ReviewRecordList({ rules, batches, ruleId, selectedId, runningRules, onRuleChange, onOpen }: ReviewRecordListProps) {
  const { t } = useTranslation('workspace');
  const locale = intlLocale();
  const [attention, setAttention] = useState(false);
  const activeRule = rules.some((rule) => rule.id === ruleId) ? ruleId : '';
  const rows = batches.filter((batch) => {
    if (activeRule && batch.ruleId !== activeRule) return false;
    if (attention && !needsAttention(batch)) return false;
    return true;
  });
  const placeholders = runningRules.filter((rule) => {
    if (activeRule && rule.id !== activeRule) return false;
    const cutoff = Date.parse(rule.startedAt) - 5000;
    return !batches.some((batch) => batch.ruleId === rule.id && Date.parse(batch.createdAt) >= cutoff);
  });
  const empty = placeholders.length === 0 && rows.length === 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-lg border p-1" role="group" aria-label={t('reviews.recordsFilterAria')}>
          <Button type="button" size="sm" variant={attention ? 'ghost' : 'secondary'} aria-pressed={!attention} onClick={() => setAttention(false)}>{t('reviews.filterAll')}</Button>
          <Button type="button" size="sm" variant={attention ? 'secondary' : 'ghost'} aria-pressed={attention} onClick={() => setAttention(true)}>{t('reviews.filterAttention')}</Button>
        </div>
        <NativeSelect className="glass-control h-8 max-w-full min-w-0 flex-1 rounded-lg px-2 text-sm sm:max-w-56 sm:flex-none" aria-label={t('reviews.ruleFilterAria')} value={activeRule} onChange={(event) => onRuleChange(event.target.value || null)}>
          <option value="">{t('reviews.allRules')}</option>
          {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
        </NativeSelect>
      </div>
      <Surface as="div" tone="subtle" className="overflow-hidden rounded-xl">
        {placeholders.map((rule) => (
          <div key={`running-${rule.id}`} aria-busy="true" className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 first:border-t-0">
            <Badge variant="outline" className={statusClass.generating}>{t('reviews.statusGenerating')}</Badge>
            <span className="min-w-0 font-medium break-words">{rule.name}</span>
          </div>
        ))}
        {rows.map((batch) => {
          const range = coverage(batch, locale, (from, through) => t('reviews.coverage', { from, through }));
          const counts = batch.counts;
          return (
            <div key={batch.id} className={cn('border-t border-border first:border-t-0', selectedId === batch.id && 'bg-muted/60')}>
              <Button variant="row" size="bare" type="button" className={cn('flex w-full flex-col gap-1 px-4 pt-3 text-left hover:bg-muted/60', batch.pendingProposalCount > 0 ? 'pb-1' : 'pb-3')} onClick={() => onOpen(batch.id)}>
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusClass[batch.status]}>{t(statusKey[batch.status])}</Badge>
                  <span className="min-w-0 font-medium break-words">{batch.ruleName || t('reviews.fallbackName')}</span>
                  {batch.ruleDeleted && <span className="text-xs text-muted-foreground">{t('reviews.ruleDeletedTag')}</span>}
                  <span className="text-xs text-muted-foreground">{stamp(batch.createdAt, locale)}</span>
                  {range && <span className="text-xs text-muted-foreground">{range}</span>}
                </span>
                {counts && (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t('reviews.statAdded')} <b className="text-foreground">{counts.added}</b></span>
                    <span>{t('reviews.statCompleted')} <b className="text-foreground">{counts.completed}</b></span>
                    <span>{t('reviews.statOverdue')} <b className="text-foreground">{counts.overdue}</b></span>
                    <span>{t('reviews.statBlocked')} <b className="text-foreground">{counts.blocked}</b></span>
                  </span>
                )}
              </Button>
              {batch.pendingProposalCount > 0 && (
                <a className="inline-block px-4 pb-3 text-xs underline underline-offset-4" href="#/proposals">{t('reviews.goConfirm', { count: batch.pendingProposalCount })}</a>
              )}
            </div>
          );
        })}
        {empty && <p className="px-4 py-8 text-sm text-muted-foreground">{attention || activeRule ? t('reviews.filteredEmpty') : t('reviews.empty')}</p>}
      </Surface>
    </div>
  );
}
