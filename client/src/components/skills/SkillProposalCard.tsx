import { useState } from 'react';
import type { AppReviewEntity } from '../../../../server/src/domain/task-batch-types.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { DiffLines } from './SkillEditor.js';
import { lineDiff } from './skill-format.js';

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

/** Body of a skill.create / skill.update card. The buttons stay in ReviewCard so confirm and cancel use the same path as other cards. */
export function SkillProposalDetails({ entity }: { entity: AppReviewEntity }) {
  const [full, setFull] = useState(false);
  const field = (key: string) => entity.fields.find((item) => item.key === key);
  const creating = entity.operation === 'create';
  const name = entity.titleAfter || entity.titleBefore || '未命名技能';
  const description = field('description');
  const enabled = field('enabled');
  const instructions = field('instructions');
  const name0 = field('name');
  return (
    <div className="review-overview grid gap-2" data-testid="skill-proposal" data-operation={entity.operation}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">{creating ? '新建技能' : `更新技能 · v${entity.revisionBefore ?? '?'} → v${(entity.revisionBefore ?? 0) + 1}`}</span>
        <h3 className="!m-0 min-w-0 flex-1 break-words">{name}</h3>
      </div>
      {!creating && name0 && <p className="text-sm"><span className="mr-2 text-muted-foreground">名称</span>{text(name0.before)} → {text(name0.after)}</p>}
      {description && <p className="text-sm"><span className="mr-2 text-muted-foreground">描述</span>{creating ? text(description.after) : `${text(description.before)} → ${text(description.after)}`}</p>}
      {enabled && <p className="text-sm"><span className="mr-2 text-muted-foreground">启用</span>{creating ? (enabled.after ? '启用' : '停用') : `${enabled.before ? '启用' : '停用'} → ${enabled.after ? '启用' : '停用'}`}</p>}
      {instructions && (creating
        ? <div className={full ? '' : 'max-h-56 overflow-hidden'} data-testid="skill-proposal-body"><div className="rounded-lg border p-3"><MarkdownView content={text(instructions.after)} /></div></div>
        : <DiffLines label="正文变化" lines={lineDiff(text(instructions.before), text(instructions.after))} />)}
      {instructions && creating && <button type="button" className="review-tech-trigger !mt-0 justify-self-start" onClick={() => setFull((value) => !value)}>{full ? '收起正文' : '展开完整正文'}</button>}
      {!instructions && !creating && <p className="text-sm text-muted-foreground">正文不变</p>}
    </div>
  );
}
