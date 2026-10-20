import { useTranslation } from 'react-i18next';
import { itemMark, type ProposalAnalysis, type ProposalItem } from '@/lib/proposal-group.js';
import { Badge } from '@/components/ui/badge.js';
import { cn } from '@/lib/utils.js';
import { CommandFields } from './EditFields.js';
import { recordOf } from './present.js';

function ItemBody({ item, editing, onChange }: { item: ProposalItem; editing: boolean; onChange: (key: string, value: unknown) => void }) {
  const before = recordOf(item.detail.before);
  const diff = !item.created && !item.deleted && Object.keys(before).length > 0;
  return <CommandFields item={item} editing={editing} onChange={onChange} diff={diff} quoteReason={item.kind.startsWith('memory.')} />;
}

export function GroupTree({ analysis, editing, onChange }: { analysis: ProposalAnalysis; editing: boolean; onChange: (index: number, key: string, value: unknown) => void }) {
  const { t } = useTranslation('proposals');
  return (
    <ol className="space-y-2">
      {analysis.items.map((item) => (
        <li key={item.index} className={cn('space-y-2 rounded-lg border border-[var(--glass-border)] p-3', item.parentIndex && 'ml-4')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{itemMark(item.index)}</span>
            <Badge variant="outline">{item.created ? t('group.created') : item.deleted ? t('group.deleted') : t('group.updated')}</Badge>
            <span className="min-w-0 flex-1 break-words text-sm font-medium">{item.title || t('head.untitled')}</span>
          </div>
          {item.parentIndex ? <p className="text-xs text-muted-foreground">{t('group.childOf', { mark: itemMark(item.parentIndex) })}</p> : null}
          {!item.parentIndex && item.dependsOn.length ? <p className="text-xs text-muted-foreground">{t('group.dependsOn', { mark: item.dependsOn.map((index) => itemMark(index)).join(t('listSeparator')) })}</p> : null}
          <ItemBody item={item} editing={editing} onChange={(key, value) => onChange(item.index - 1, key, value)} />
        </li>
      ))}
    </ol>
  );
}
