import type { Topic } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';

type SummaryPanelProps = {
  detail?: Topic;
  busy?: boolean;
  onConfirm?: (action: 'confirm' | 'discard') => void;
};

export function SummaryPanel({ detail, busy = false, onConfirm }: SummaryPanelProps) {
  if (!detail) return null;
  if (detail.draftSummary) {
    return (
      <section className="my-4 rounded-lg border border-warning-border bg-warning-bg p-4 text-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <strong className="text-warning">成果草稿</strong>
            <p className="mt-2 leading-relaxed whitespace-pre-wrap">{detail.draftSummary}</p>
          </div>
          {onConfirm && (
            <div className="flex shrink-0 justify-end gap-2 max-md:grid max-md:w-full max-md:grid-cols-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onConfirm('discard')}>放弃草稿</Button>
              <Button size="sm" disabled={busy} onClick={() => onConfirm('confirm')}>确认成果</Button>
            </div>
          )}
        </div>
      </section>
    );
  }
  if (detail.finalSummary) {
    return (
      <section className="my-4 rounded-lg border border-success-border bg-success-bg p-4 text-sm">
        <strong className="text-success">正式成果</strong>
        <p className="mt-2 leading-relaxed whitespace-pre-wrap">{detail.finalSummary}</p>
        {detail.summaryUpdatedAt && <small className="mt-2 block text-xs text-muted-foreground">已确认：{new Date(detail.summaryUpdatedAt).toLocaleString()}</small>}
      </section>
    );
  }
  return null;
}
