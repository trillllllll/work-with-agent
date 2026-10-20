import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppReviewEntity } from '../../../../server/src/domain/task-batch-types.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { DiffLines } from './SkillEditor.js';
import { lineDiff } from './skill-format.js';

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

/** Body of a skill.create / skill.update card. The buttons stay in ReviewCard so confirm and cancel use the same path as other cards. */
export function SkillProposalDetails({ entity }: { entity: AppReviewEntity }) {
  const { t } = useTranslation('skills');
  const [full, setFull] = useState(false);
  const field = (key: string) => entity.fields.find((item) => item.key === key);
  const creating = entity.operation === 'create';
  const name = entity.titleAfter || entity.titleBefore || t('proposal.untitled');
  const description = field('description');
  const enabled = field('enabled');
  const instructions = field('instructions');
  const name0 = field('name');
  const enabledText = (value: unknown) => value ? t('state.enabled') : t('state.disabled');
  return (
    <div className="review-overview grid gap-2" data-testid="skill-proposal" data-operation={entity.operation}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">{creating ? t('proposal.creating') : t('proposal.updating', { from: entity.revisionBefore ?? '?', to: (entity.revisionBefore ?? 0) + 1 })}</span>
        <h3 className="!m-0 min-w-0 flex-1 break-words">{name}</h3>
      </div>
      {!creating && name0 && <p className="text-sm"><span className="mr-2 text-muted-foreground">{t('proposal.name')}</span>{text(name0.before)} → {text(name0.after)}</p>}
      {description && <p className="text-sm"><span className="mr-2 text-muted-foreground">{t('proposal.description')}</span>{creating ? text(description.after) : t('proposal.transition', { before: text(description.before), after: text(description.after) })}</p>}
      {enabled && <p className="text-sm"><span className="mr-2 text-muted-foreground">{t('proposal.enabled')}</span>{creating ? enabledText(enabled.after) : t('proposal.transition', { before: enabledText(enabled.before), after: enabledText(enabled.after) })}</p>}
      {instructions && (creating
        ? <div className={full ? '' : 'max-h-56 overflow-hidden'} data-testid="skill-proposal-body"><div className="rounded-lg border p-3"><MarkdownView content={text(instructions.after)} /></div></div>
        : <DiffLines label={t('proposal.bodyChanged')} lines={lineDiff(text(instructions.before), text(instructions.after))} />)}
      {instructions && creating && <button type="button" className="review-tech-trigger !mt-0 justify-self-start" onClick={() => setFull((value) => !value)}>{full ? t('proposal.collapseBody') : t('proposal.expandBody')}</button>}
      {!instructions && !creating && <p className="text-sm text-muted-foreground">{t('proposal.bodyUnchanged')}</p>}
    </div>
  );
}
