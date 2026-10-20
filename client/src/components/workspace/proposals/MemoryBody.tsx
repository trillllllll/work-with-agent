import { useTranslation } from 'react-i18next';
import { importanceBand } from '@/lib/proposal-fields.js';
import type { ProposalItem } from '@/lib/proposal-group.js';
import { asLabels, memoryKindLabel, originLabel, Stars } from '@/components/workspace/memory-view.js';
import { CommandFields } from './EditFields.js';
import { stringOf } from './present.js';

export function MemoryBody({ item, editing, onChange }: { item: ProposalItem; editing: boolean; onChange: (key: string, value: unknown) => void }) {
  const { t } = useTranslation('proposals');
  const input = item.command.input ?? {};
  const detail = item.detail;
  const kind = stringOf(input.kind) || stringOf(detail.kind);
  const origin = stringOf(input.origin) || stringOf(detail.origin);
  const importanceValue = typeof input.importance === 'number' ? input.importance : typeof detail.importance === 'number' ? detail.importance : null;
  const labels = asLabels(input.labels ?? detail.labels);
  const detailTitle = stringOf(input.title) || stringOf(detail.title);
  const detailContent = stringOf(input.content) || stringOf(detail.content);
  const detailReason = stringOf(input.reason) || stringOf(detail.reason);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {kind ? <span className="proposal-chip" data-tone="warning">{memoryKindLabel(kind)}</span> : null}
        {importanceValue != null ? (
          <span className="inline-flex items-center gap-1">
            <span>{t('memory.importance')}</span>
            <Stars value={importanceValue} />
            <span>{t(`memory.importanceLevel.${importanceBand(importanceValue)}`)}</span>
          </span>
        ) : null}
        {origin ? <span>{originLabel(origin)}</span> : null}
      </div>
      {labels.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t('memory.labels')}</span>
          {labels.map((label) => <span key={label} className="proposal-chip">{label}</span>)}
        </div>
      ) : null}
      {!editing && detailTitle ? <p className="text-base font-semibold">{detailTitle}</p> : null}
      {!editing && detailContent ? <p className="whitespace-pre-wrap text-sm">{detailContent}</p> : null}
      {!editing && detailReason ? <blockquote className="border-l-2 border-[var(--glass-border)] pl-3 text-sm text-muted-foreground">{t('memory.why', { reason: detailReason })}</blockquote> : null}
      <CommandFields item={item} editing={editing} onChange={onChange} quoteReason omitKeys={editing ? [] : ['title', 'content', 'reason']} />
    </div>
  );
}
