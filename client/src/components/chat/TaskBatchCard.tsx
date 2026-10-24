import { Surface } from '@/components/ui/surface.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Button } from '@/components/ui/button.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Approval } from '@/chat.js';
import { t } from '../../i18n/index.js';

type Preview = NonNullable<Approval['preview']>;
type Snapshot = Preview['beforeTasks'][number];
type Delta = Preview['changes'][number];

const fieldKeys = new Set(['title', 'topicId', 'parentId', 'status', 'priority', 'description', 'resultSummary', 'dueDate', 'scheduledStart', 'scheduledEnd', 'estimatedMinutes', 'tagIds']);

export function isTaskBatchApproval(approval?: Approval) {
  return Boolean(approval && (approval.resultState === 'batch' || approval.preview));
}

function fieldLabel(field: string) {
  return fieldKeys.has(field) ? t(`chat:taskBatch.field.${field}`) : field;
}

function titleOf(id: unknown, tasks: Snapshot[]) {
  if (typeof id !== 'string' || !id) return t('chat:taskBatch.topLevel');
  return tasks.find((task) => task.id === id)?.title ?? t('chat:taskBatch.untitledTask');
}

function fieldText(field: string, value: unknown, tasks: Snapshot[]) {
  if (value == null || value === '') return t('chat:taskBatch.empty');
  if (field === 'parentId') return titleOf(value, tasks);
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(t('chat:taskBatch.listJoiner')) : t('chat:taskBatch.empty');
  return String(value);
}

function treeOf(tasks: Snapshot[]) {
  const present = new Set(tasks.map((task) => task.id));
  const children = new Map<string | null, Snapshot[]>();
  for (const task of tasks) {
    const parent = task.parentId && present.has(task.parentId) ? task.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  for (const list of children.values()) list.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  return children;
}

function NodeList({ parent, children, nested, labelFor, created, mark }: { parent: string | null; children: Map<string | null, Snapshot[]>; nested: boolean; labelFor: (task: Snapshot) => string; created: Set<string>; mark: boolean }) {
  const { t: label } = useTranslation('chat');
  const items = children.get(parent) ?? [];
  if (!items.length) return null;
  return (
    <ul className={nested ? 'task-batch-children' : 'task-batch-nodes'}>
      {items.map((task) => (
        <li key={task.id} className="task-batch-node" data-task-id={task.id} {...(created.has(task.id) ? { 'data-created': 'true' } : {})}>
          {mark && <span className="task-batch-kind">{created.has(task.id) ? label('taskBatch.created') : label('taskBatch.kept')}</span>}
          <span className="task-batch-node-title">{labelFor(task)}</span>
          <NodeList parent={task.id} children={children} nested labelFor={labelFor} created={created} mark={mark} />
        </li>
      ))}
    </ul>
  );
}

function Tree({ title, testId, tasks, labelFor, created, mark }: { title: string; testId: string; tasks: Snapshot[]; labelFor: (task: Snapshot) => string; created: Set<string>; mark: boolean }) {
  return (
    <div className="task-batch-panel" data-testid={testId}>
      <h3>{title}</h3>
      <NodeList parent={null} children={treeOf(tasks)} nested={false} labelFor={labelFor} created={created} mark={mark} />
    </div>
  );
}

export function batchCardState(approval: Approval, executing: boolean, unknown: boolean) {
  if (executing) return 'executing';
  if (unknown) return 'unknown';
  if (approval.supersededByApprovalId) return 'superseded';
  if (approval.outcome?.success === true) return 'executed';
  if (approval.outcome?.success === false && approval.outcome.code === 'USER_REJECTED') return 'rejected';
  if (approval.outcome?.success === false) return 'failed';
  if (approval.status === 'executed' || approval.status === 'failed' || approval.status === 'rejected') return approval.status;
  return 'pending';
}

function statusCopy(state: string) {
  if (state === 'executing') return t('chat:taskBatch.executing');
  if (state === 'executed') return t('chat:taskBatch.executed');
  if (state === 'failed') return t('chat:taskBatch.failed');
  if (state === 'rejected') return t('chat:taskBatch.rejected');
  if (state === 'superseded') return t('chat:taskBatch.superseded');
  if (state === 'unknown') return t('chat:taskBatch.checking');
  return t('chat:taskBatch.waiting');
}

function StatusIcon() {
  return (
    <svg className="task-batch-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v4l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function TaskBatchCard({ approval, executing = false, unknown = false, onApprove, onReject }: { approval: Approval; executing?: boolean; unknown?: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const { t: label } = useTranslation('chat');
  const [pressed, setPressed] = useState(false);
  const sawExecuting = useRef(false);
  useEffect(() => {
    if (executing) sawExecuting.current = true;
    if (!executing && sawExecuting.current) {
      sawExecuting.current = false;
      setPressed(false);
    }
  }, [executing]);
  const preview = approval.preview;
  const state = batchCardState(approval, executing || pressed, unknown && !pressed);
  const tasks = [...(preview?.beforeTasks ?? []), ...(preview?.afterTasks ?? [])];
  const created = new Set((preview?.afterTasks ?? []).filter((task) => !(preview?.beforeTasks ?? []).some((before) => before.id === task.id)).map((task) => task.id));
  const explicit = (preview?.changes ?? []).filter((change) => change.origin === 'explicit');
  const related = (preview?.changes ?? []).filter((change) => change.origin === 'related');
  const showActions = state === 'pending' || state === 'executing' || state === 'unknown';
  const busy = state === 'executing';
  const afterLabel = (task: Snapshot) => {
    const renamed = preview?.changes.find((change) => change.taskId === task.id)?.fields.find((field) => field.field === 'title');
    if (renamed && typeof renamed.before === 'string') return `${renamed.before} → ${task.title}`;
    return task.title;
  };
  const line = (change: Delta, field: Delta['fields'][number], relatedChange = false) => {
    const name = change.before?.title ?? change.after.title;
    return label(relatedChange ? 'taskBatch.relatedChange' : 'taskBatch.change', {
      name,
      label: fieldLabel(field.field),
      before: fieldText(field.field, field.before, tasks),
      after: fieldText(field.field, field.after, tasks),
    });
  };
  return (
    <Surface as="section" tone="card" className="task-batch-card" aria-label={label('taskBatch.ariaLabel')} data-testid="task-batch-card" data-approval-id={approval.approvalId} data-state={state}>
      <h2 className="task-batch-title">{label('taskBatch.title')}</h2>
      <p className="task-batch-status" data-testid="batch-status" data-tone={state} {...(state === 'executing' ? { role: 'status', 'aria-live': 'polite' as const } : {})}>
        <StatusIcon />
        <span>{statusCopy(state)}</span>
      </p>
      {preview?.summary && <p className="task-batch-summary">{preview.summary}</p>}
      {preview && (
        <div className="task-batch-trees">
          <Tree title={label('taskBatch.before')} testId="batch-before" tasks={preview.beforeTasks} labelFor={(task) => task.title} created={new Set()} mark={false} />
          <Tree title={label('taskBatch.after')} testId="batch-after" tasks={preview.afterTasks} labelFor={afterLabel} created={created} mark />
        </div>
      )}
      {explicit.length > 0 && (
        <div className="task-batch-changes">
          <h3>{label('taskBatch.changesTitle')}</h3>
          <ul>
            {explicit.flatMap((change) => change.fields.map((field) => <li key={`${change.taskId}:${field.field}`}>{line(change, field)}</li>))}
          </ul>
        </div>
      )}
      {state === 'failed' && approval.outcome?.success === false && <p className="task-batch-alert" role="alert">{approval.outcome.error}</p>}
      <Disclosure className="task-batch-details">
        <DisclosureTrigger>{label('taskBatch.viewImpact')}</DisclosureTrigger>
        <ul>
          {related.flatMap((change) => change.fields.map((field) => <li key={`related:${change.taskId}:${field.field}`}>{line(change, field, true)}</li>))}
          {(preview?.afterTasks ?? preview?.beforeTasks ?? []).map((task) => <li key={task.id}>{label('taskBatch.versionLine', { title: task.title, id: task.id, revision: task.revision })}</li>)}
        </ul>
      </Disclosure>
      {showActions && (
        <div className="task-batch-actions">
          <Button variant="outline" size="bare" type="button" className="task-batch-secondary" disabled={busy} onClick={() => { setPressed(true); onReject(approval.approvalId); }}>{label('actions.reject')}</Button>
          <Button variant="default" size="bare" type="button" className="task-batch-primary" disabled={busy} onClick={() => { setPressed(true); onApprove(approval.approvalId); }}>{busy ? label('taskBatch.executing') : label('taskBatch.confirm')}</Button>
        </div>
      )}
    </Surface>
  );
}
