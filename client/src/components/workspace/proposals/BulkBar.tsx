import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

export function BulkBar({ groups, items, running, result, onClear, onApprove, onReject }: {
  groups: number;
  items: number;
  running: boolean;
  result: { ok: number; fail: number } | null;
  onClear: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation('proposals');
  if (!groups && !running && !result) return null;
  const summary = running ? t('bulk.running') : groups > 0 ? t('bulk.selected', { groups, items }) : '';
  return (
    <div
      role="region"
      aria-label={t('bulk.selected', { groups, items })}
      className={cn(
        'glass-subtle flex flex-wrap items-center gap-2 rounded-xl px-3 py-2',
        'max-sm:fixed max-sm:inset-x-3 max-sm:z-40 max-sm:bottom-[calc(4.25rem+env(safe-area-inset-bottom))] max-sm:shadow-lg',
      )}
    >
      {summary ? <span className="min-w-0 flex-1 text-sm">{summary}</span> : <span className="min-w-0 flex-1" />}
      {result && !running ? <span className="text-sm text-muted-foreground">{t('bulk.result', { ok: result.ok, fail: result.fail })}</span> : null}
      <Button type="button" variant="ghost" size="sm" disabled={running} onClick={onClear}>{t('bulk.clear')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={running || groups < 1} onClick={onReject}>{t('bulk.reject')}</Button>
      <Button type="button" size="sm" disabled={running || groups < 1} onClick={onApprove}>{t('bulk.approve')}</Button>
    </div>
  );
}
