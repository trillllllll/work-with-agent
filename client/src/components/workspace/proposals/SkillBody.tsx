import { useTranslation } from 'react-i18next';
import type { ProposalItem } from '@/lib/proposal-group.js';
import { CommandFields } from './EditFields.js';
import { stringOf } from './present.js';

export function SkillBody({ item, editing, onChange }: { item: ProposalItem; editing: boolean; onChange: (key: string, value: unknown) => void }) {
  const { t } = useTranslation('proposals');
  const input = item.command.input ?? {};
  const name = stringOf(input.name) || stringOf(item.detail.name) || item.title || t('head.untitled');
  const enabledAfter = item.created && input.enabled !== false;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{name}</h3>
      {enabledAfter ? <p className="text-sm text-muted-foreground">{t('skill.enabledAfter')}</p> : null}
      <CommandFields item={item} editing={editing} onChange={onChange} omitKeys={['name']} />
    </div>
  );
}
