import { useTranslation } from 'react-i18next';
import type { ProposalItem } from '@/lib/proposal-group.js';
import { CommandFields } from './EditFields.js';
import { recordOf } from './present.js';

export function TaskDiff({ item, editing, onChange }: { item: ProposalItem; editing: boolean; onChange: (key: string, value: unknown) => void }) {
  const { t } = useTranslation('proposals');
  const before = recordOf(item.detail.before);
  const revision = typeof before.revision === 'number' ? before.revision : item.command.expectedRevision;
  return (
    <div className="space-y-3">
      {typeof revision === 'number' ? <p className="text-xs text-muted-foreground">{t('task.basedOn', { revision })}</p> : null}
      <CommandFields item={item} editing={editing} onChange={onChange} diff />
    </div>
  );
}
