import { CalendarDays, Check, ClipboardList } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Approval } from '@/chat.js';
import { reviewCardState, reviewStatusCopy } from '@/chat.js';
import type { AppReviewEntity } from '../../../../server/src/domain/task-batch-types.js';
import { api } from '@/lib/api.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';

const CLIP = 240;

function clipText(value: string) {
  const chars = Array.from(value);
  if (chars.length <= CLIP) return { text: value, clipped: false };
  return { text: `${chars.slice(0, CLIP).join('')}…`, clipped: true };
}

function FieldDiff({ label, before, after }: { label: string; before: string; after: string }) {
  const { t } = useTranslation('chat');
  const [full, setFull] = useState(false);
  const left = clipText(before);
  const right = clipText(after);
  const clipped = left.clipped || right.clipped;
  return (
    <div className="review-field">
      <span className="review-field-label">{label}</span>
      <div className="review-diff">
        <span>{full ? before : left.text}</span>
        <span aria-hidden="true">→</span>
        <span>{full ? after : right.text}</span>
      </div>
      {clipped && <button type="button" className="task-batch-secondary review-inline" onClick={() => setFull((value) => !value)}>{full ? t('review.collapseDiff') : t('review.expandDiff')}</button>}
    </div>
  );
}

type TreeNode = { id: string; title: string; parentId: string | null; created: boolean };

function parentIdOf(entity: AppReviewEntity, side: 'before' | 'after') {
  const field = entity.fields.find((item) => item.key === 'parentId');
  const value = side === 'before' ? field?.before : field?.after;
  return typeof value === 'string' && value ? value : null;
}

function treeNodes(entities: AppReviewEntity[], side: 'before' | 'after', untitled: string): TreeNode[] {
  return entities.flatMap((entity) => {
    if (entity.entityType !== 'task') return [];
    if (side === 'before' && entity.operation === 'create') return [];
    if (side === 'after' && entity.operation === 'delete') return [];
    const title = (side === 'before' ? entity.titleBefore : entity.titleAfter) || entity.titleAfter || entity.titleBefore || untitled;
    return [{ id: entity.entityId, title, parentId: parentIdOf(entity, side), created: entity.operation === 'create' }];
  });
}

function childrenOf(nodes: TreeNode[]) {
  const present = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && present.has(node.parentId) ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  for (const list of children.values()) list.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return children;
}

function NodeList({ parent, children, nested, mark }: { parent: string | null; children: Map<string | null, TreeNode[]>; nested: boolean; mark: boolean }) {
  const { t } = useTranslation('chat');
  const items = children.get(parent) ?? [];
  if (!items.length) return null;
  return (
    <ul className={nested ? 'task-batch-children' : 'task-batch-nodes'}>
      {items.map((node) => (
        <li key={node.id} className="task-batch-node" data-task-id={node.id} {...(mark && node.created ? { 'data-created': 'true' } : {})}>
          {mark && <span className="task-batch-kind">{node.created ? t('review.created') : t('review.kept')}</span>}
          <span className="task-batch-node-title">{node.title}</span>
          <NodeList parent={node.id} children={children} nested mark={mark} />
        </li>
      ))}
    </ul>
  );
}

function ParentTrees({ entities }: { entities: AppReviewEntity[] }) {
  const { t } = useTranslation('chat');
  const tasks = entities.filter((entity) => entity.entityType === 'task');
  const structural = tasks.some((entity) => entity.operation === 'create' || entity.operation === 'delete' || entity.fields.some((field) => field.key === 'parentId'));
  if (!structural) return null;
  const before = treeNodes(entities, 'before', t('review.untitled'));
  const after = treeNodes(entities, 'after', t('review.untitled'));
  return (
    <div className="task-batch-trees">
      <div className="task-batch-panel" data-testid="batch-before">
        <h3>{t('review.before')}</h3>
        <NodeList parent={null} children={childrenOf(before)} nested={false} mark={false} />
      </div>
      <div className="task-batch-panel" data-testid="batch-after">
        <h3>{t('review.after')}</h3>
        <NodeList parent={null} children={childrenOf(after)} nested={false} mark />
      </div>
    </div>
  );
}

function EntityBlock({ entity }: { entity: AppReviewEntity }) {
  const { t } = useTranslation('chat');
  const title = entity.titleAfter || entity.titleBefore || t('review.untitled');
  return (
    <article className="review-entity">
      <h3>{title}</h3>
      {entity.fields.map((field) => <FieldDiff key={field.key} label={field.label} before={field.beforeText} after={field.afterText} />)}
    </article>
  );
}

export function isAppChangeApproval(approval?: Approval | null) {
  return Boolean(approval && (approval.resultState === 'app_changes' || approval.appReview));
}

export function ReviewCard({ approval, phase = '', unknown = false, unresolved = false, onApprove, onReject, onChanged, onRepreviewed }: {
  approval: Approval;
  phase?: '' | 'approve' | 'reject';
  unknown?: boolean;
  unresolved?: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onChanged?: () => void;
  onRepreviewed?: (body: { approvalId?: string; previewHash?: string; supersedesApprovalId?: string; approval?: { id: string; status: string; toolName: string; conversationId?: string | null; envelope?: unknown } }) => void;
}) {
  const { t } = useTranslation('chat');
  const [localPhase, setLocalPhase] = useState<'' | 'approve' | 'reject'>('');
  const [showAll, setShowAll] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [localError, setLocalError] = useState('');
  const [requestKey] = useState(() => crypto.randomUUID());
  useEffect(() => { if (!phase) setLocalPhase(''); }, [phase, approval.status]);
  const state = reviewCardState(approval, phase || localPhase, unknown);
  const review = approval.appReview;
  const entities = review?.entities ?? [];
  const conflict = state === 'failed' && approval.appOutcome?.status === 'failed' && approval.appOutcome.code === 'VERSION_CONFLICT';
  const canUndo = state === 'executed' && approval.appOutcome?.status === 'executed' && Boolean(approval.appOutcome.changeId) && review?.reversibility === 'supported';
  const decisionLocked = state === 'approving' || state === 'rejecting' || Boolean(busyAction);
  const confirm = () => { setLocalPhase('approve'); onApprove(approval.approvalId); };
  const cancel = () => { setLocalPhase('reject'); onReject(approval.approvalId); };
  const followUp = async (path: 'repreview' | 'undo-preview') => {
    setBusyAction(path);
    setLocalError('');
    try {
      const body = await api(`/api/agent/approvals/${approval.approvalId}/${path}`, { method: 'POST', body: JSON.stringify(path === 'repreview' ? { requestKey } : {}) });
      if (path === 'repreview') onRepreviewed?.(body);
      else onChanged?.();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : t('review.repreviewFailed'));
    } finally { setBusyAction(''); }
  };
  const adjust = () => {
    window.dispatchEvent(new CustomEvent('wwa-adjust-approval', { detail: { approvalId: approval.approvalId, conversationId: approval.conversationId, title: review?.title || review?.intent || t('review.proposal') } }));
  };
  const count = review?.relatedEntityCount ?? 0;
  const relatedText = (executed: boolean) => {
    if (executed) {
      if (review?.reversibility === 'unsupported') return review.reversibilityReason ? t('review.relatedExecutedUnsupported', { count, reason: review.reversibilityReason }) : t('review.relatedExecutedUnsupportedDefault', { count });
      return t('review.relatedExecutedUndo', { count });
    }
    if (review?.reversibility === 'unsupported') return review.reversibilityReason ? t('review.relatedPendingUnsupported', { count, reason: review.reversibilityReason }) : t('review.relatedPendingUnsupportedBare', { count });
    return review ? t('review.relatedPendingUndo', { count }) : t('review.relatedCount', { count });
  };
  if (state === 'executed') return <section className="task-batch-card review-receipt" aria-label={review?.title || t('review.result')} data-testid="approval-card" data-approval-id={approval.approvalId} data-state={state}>
    <div className="flex flex-wrap items-center gap-2"><Check size={16} className="shrink-0 text-green-700 dark:text-green-300" /><h2 className="min-w-0 flex-1 text-sm font-medium" tabIndex={-1}>{entities.length === 1 ? entities[0].titleAfter || entities[0].titleBefore || review?.title : review?.title}</h2><span className="text-xs text-muted-foreground" role="status">{reviewStatusCopy(state, approval, unresolved)}</span></div>
    <div className="mt-2 flex flex-wrap gap-3">
      {entities.length === 1 && entities[0].entityType === 'task' && entities[0].operation !== 'delete' && <button type="button" className="review-tech-trigger !mt-0" onClick={() => window.dispatchEvent(new CustomEvent('wwa-open-task', { detail: { taskId: entities[0].entityId } }))}>{t('review.viewTask')}</button>}
      {canUndo && <button type="button" className="review-tech-trigger !mt-0" disabled={Boolean(busyAction)} onClick={() => void followUp('undo-preview')}>{t('actions.undo')}</button>}
      <button type="button" className="review-tech-trigger !mt-0" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? t('review.collapseResult') : t('review.viewResult')}</button>
    </div>
    {showAll && <div className="mt-3"><div data-testid="approval-impact">{(review?.consequences ?? []).map((line) => <p key={line} className="task-batch-summary">{line}</p>)}</div><p className="task-batch-summary" data-testid="approval-related">{relatedText(true)}</p><div className="review-entities">{entities.map((entity) => <EntityBlock key={`${entity.entityType}:${entity.entityId}`} entity={entity} />)}</div></div>}
    {localError && <p className="task-batch-alert" role="alert">{localError}</p>}
  </section>;
  return (
    <section className="task-batch-card" aria-label={review?.title || t('review.proposal')} data-testid="approval-card" data-approval-id={approval.approvalId} data-state={state}>
      <div className="review-heading"><span className="review-symbol"><ClipboardList size={18} /></span><div><span className="review-kicker">{approval.reversesApprovalId ? t('review.undoPreview') : t('review.changePreview')}</span><h2 className="task-batch-title" tabIndex={-1}>{review?.title || t('review.proposal')}</h2></div></div>
      <p className="task-batch-status" data-tone={state === 'rejected' || state === 'superseded' || state === 'capability_removed' ? 'neutral' : state === 'approving' || state === 'rejecting' ? 'pending' : state} role="status">
        <span>{reviewStatusCopy(state, approval, unresolved)}</span>
      </p>
      <div data-testid="approval-impact">
        {(review?.consequences ?? []).map((line) => <p key={line} className="task-batch-summary">{line}</p>)}
        {state === 'failed' && approval.appOutcome?.status === 'failed' && <p className="task-batch-alert" role="alert">{approval.appOutcome.message}</p>}
        {state === 'capability_removed' && <p className="task-batch-summary">{t('reviewStatus.capabilityRemoved')}</p>}
      </div>
      <p className="task-batch-summary" data-testid="approval-related">{relatedText(false)}</p>
      {entities.length === 1 && <div className="review-overview"><h3>{entities[0].titleAfter || entities[0].titleBefore || t('review.untitled')}</h3>{entities[0].fields.filter((field) => ['topicId', 'scheduledStart', 'scheduledEnd', 'scheduledDate', 'scheduledTime', 'estimatedMinutes'].includes(field.key)).map((field) => <p key={field.key}><CalendarDays size={14} aria-hidden="true" /><span>{field.label}</span><strong>{field.afterText}</strong></p>)}</div>}
      <Collapsible open={showAll} onOpenChange={setShowAll}>
        <CollapsibleTrigger className="review-tech-trigger">{showAll ? t('review.collapseAll') : t('review.allChanges', { count: entities.length })}</CollapsibleTrigger>
        <CollapsibleContent><ParentTrees entities={entities} /><div className="review-entities">{entities.map((entity) => <EntityBlock key={`${entity.entityType}:${entity.entityId}`} entity={entity} />)}</div></CollapsibleContent>
      </Collapsible>
      <Collapsible open={techOpen} onOpenChange={setTechOpen}>
        <CollapsibleTrigger className="review-tech-trigger">{t('review.technicalDetails')}</CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="task-batch-details">
            <li>{t('review.previewHash', { hash: String(approval.previewHash || review?.previewHash) })}</li>
            <li>{t('review.revision', { revision: approval.proposalRevision ?? t('review.unrecorded') })}</li>
            {entities.map((entity) => <li key={`tech:${entity.entityId}`}>{t('review.entityRevision', { type: entity.entityType, id: entity.entityId, before: entity.revisionBefore ?? t('review.unset'), after: entity.revisionAfter ?? t('review.unset') })}</li>)}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      {localError && <p className="task-batch-alert" role="alert">{localError}</p>}
      {state === 'pending' && (
        <div className="task-batch-actions">
          <button type="button" className="task-batch-secondary" disabled={decisionLocked} onClick={cancel}>{t('actions.cancel')}</button>
          <button type="button" className="task-batch-secondary" disabled={decisionLocked} onClick={adjust}>{t('review.adjust')}</button>
          <button type="button" className="task-batch-primary" disabled={decisionLocked} onClick={confirm}>{t('review.confirm')}</button>
        </div>
      )}
      {conflict && <div className="task-batch-actions"><button type="button" className="task-batch-primary" disabled={Boolean(busyAction)} onClick={() => void followUp('repreview')}>{t('review.repreview')}</button></div>}
      {canUndo && <div className="task-batch-actions"><button type="button" className="task-batch-secondary" disabled={Boolean(busyAction)} onClick={() => void followUp('undo-preview')}>{t('actions.undo')}</button></div>}
      {state === 'superseded' && approval.supersededByApprovalId && <div className="task-batch-actions"><button type="button" className="task-batch-secondary" onClick={() => window.dispatchEvent(new CustomEvent('wwa-locate-approval', { detail: { approvalId: approval.supersededByApprovalId } }))}>{t('review.viewNewProposal')}</button></div>}
    </section>
  );
}
