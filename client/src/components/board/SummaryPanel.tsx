import { useTranslation } from 'react-i18next';
import type { Topic } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { BodyText } from '@/components/shared/BodyText.js';

type SummaryPanelProps = {
  detail?: Topic;
  busy?: boolean;
  onConfirm?: (action: 'confirm' | 'discard') => void;
};

export function SummaryPanel({ detail, busy = false, onConfirm }: SummaryPanelProps) {
  const { t } = useTranslation('plan');
  if (!detail) return null;
  if (detail.draftSummary) {
    return (
      <section className="my-4 rounded-2xl border border-warning-border bg-warning-bg/75 p-4 text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <strong className="text-warning">{t('summary.draft')}</strong>
            <BodyText text={detail.draftSummary} className="mt-2 leading-relaxed" />
          </div>
          {onConfirm && (
            <div className="flex shrink-0 justify-end gap-2 max-md:grid max-md:w-full max-md:grid-cols-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onConfirm('discard')}>{t('summary.discardDraft')}</Button>
              <Button size="sm" disabled={busy} onClick={() => onConfirm('confirm')}>{t('summary.confirm')}</Button>
            </div>
          )}
        </div>
      </section>
    );
  }
  if (detail.finalSummary) {
    return (
      <section className="my-4 rounded-2xl border border-success-border bg-success-bg/75 p-4 text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]">
        <strong className="text-success">{t('summary.final')}</strong>
        <BodyText text={detail.finalSummary} className="mt-2 leading-relaxed" />
        {detail.summaryUpdatedAt && <small className="mt-2 block text-xs text-muted-foreground">{t('summary.confirmedAt', { time: new Date(detail.summaryUpdatedAt).toLocaleString(intlLocale()) })}</small>}
      </section>
    );
  }
  return null;
}
