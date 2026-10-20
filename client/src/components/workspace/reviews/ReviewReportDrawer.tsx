import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ReviewBatch } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { formatInZone, localizeIsoTimes } from '@/lib/review-format.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';

const drawerClass = 'top-0! right-0! bottom-0! left-auto! flex h-dvh max-h-none w-full max-w-[520px] translate-x-0! translate-y-0! flex-col gap-0 overflow-hidden rounded-none p-0 max-md:inset-0! max-md:h-dvh! max-md:max-h-none! max-md:w-full! max-md:max-w-none! max-md:translate-x-0! max-md:translate-y-0! max-md:rounded-none!';

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

type ReviewReportDrawerProps = {
  open: boolean;
  batch: ReviewBatch | null;
  loading: boolean;
  missing: boolean;
  retrying: boolean;
  onClose: () => void;
  onRetry: (batch: ReviewBatch) => void;
};

export function ReviewReportDrawer({ open, batch, loading, missing, retrying, onClose, onRetry }: ReviewReportDrawerProps) {
  const { t } = useTranslation('workspace');
  const locale = intlLocale();
  const [copied, setCopied] = useState(false);
  const from = typeof batch?.snapshot.from === 'string' ? batch.snapshot.from : '';
  const through = typeof batch?.snapshot.through === 'string' ? batch.snapshot.through : '';
  const range = from && through ? t('reviews.coverage', { from: stamp(from, locale), through: stamp(through, locale) }) : '';
  const when = batch ? stamp(batch.createdAt, locale) : '';
  const localized = batch?.content ? localizeIsoTimes(batch.content, locale) : '';
  const counts = batch?.counts;
  const copy = () => {
    void navigator.clipboard.writeText(localized).then(() => setCopied(true)).catch(() => toast.error(t('reviews.copyFailed')));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent surface="glass" className={drawerClass}>
        <DialogHeader className="shrink-0 border-b glass-divider px-5 py-4 pr-12 text-left">
          <DialogTitle className="break-words">{batch?.ruleName || t('reviews.fallbackName')}</DialogTitle>
          <DialogDescription className="break-words">{[when, range].filter(Boolean).join(' · ') || t('reviews.recordsHeading')}</DialogDescription>
          {batch && <div className="pt-1"><Badge variant="outline" className={statusClass[batch.status]}>{t(statusKey[batch.status])}</Badge></div>}
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading && <Skeleton className="h-40 w-full rounded-xl" />}
          {!loading && missing && <p className="text-sm text-muted-foreground">{t('reviews.batchMissing')}</p>}
          {batch && (
            <>
              {counts && (
                <div className="grid grid-cols-4 gap-2">
                  {([
                    ['statAdded', counts.added],
                    ['statCompleted', counts.completed],
                    ['statOverdue', counts.overdue],
                    ['statBlocked', counts.blocked],
                  ] as const).map(([key, value]) => (
                    <div key={key} className="min-w-0 rounded-lg bg-muted px-2 py-2">
                      <b className="block text-lg tabular-nums">{value}</b>
                      <span className="block text-xs text-muted-foreground">{t(`reviews.${key}`)}</span>
                    </div>
                  ))}
                </div>
              )}
              {batch.error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">{batch.error}</p>}
              {localized.trim() ? <MarkdownView content={localized} /> : <p className="text-sm text-muted-foreground">{t('reviews.noReport')}</p>}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t glass-divider px-5 py-4">
          {batch && batch.pendingProposalCount > 0 && (
            <Button type="button" variant="outline" size="sm" asChild>
              <a href="#/proposals">{t('reviews.goConfirm', { count: batch.pendingProposalCount })}</a>
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={!localized.trim()} onClick={copy}>{copied ? t('reviews.copied') : t('reviews.copy')}</Button>
          {batch && !batch.ruleDeleted && <Button type="button" size="sm" disabled={retrying} onClick={() => onRetry(batch)}>{t('reviews.regenerate')}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
