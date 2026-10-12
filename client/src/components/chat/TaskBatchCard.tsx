import { useEffect, useRef, useState } from 'react';
import type { Approval } from '@/chat.js';

type Preview = NonNullable<Approval['preview']>;
type Snapshot = Preview['beforeTasks'][number];
type Delta = Preview['changes'][number];

const FIELD_LABELS: Record<string, string> = {
  title: '标题', topicId: '清单', parentId: '父任务', status: '状态', priority: '优先级',
  description: '说明', resultSummary: '结果摘要', dueDate: '日期', scheduledStart: '开始时间',
  scheduledEnd: '结束时间', estimatedMinutes: '预计用时', tagIds: '标签',
};

export function isTaskBatchApproval(approval?: Approval) {
  return Boolean(approval && (approval.resultState === 'batch' || approval.preview));
}

function titleOf(id: unknown, tasks: Snapshot[]) {
  if (typeof id !== 'string' || !id) return '顶级';
  return tasks.find((task) => task.id === id)?.title ?? '未命名任务';
}

function fieldText(field: string, value: unknown, tasks: Snapshot[]) {
  if (value == null || value === '') return '空';
  if (field === 'parentId') return titleOf(value, tasks);
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join('、') : '空';
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
  const items = children.get(parent) ?? [];
  if (!items.length) return null;
  return (
    <ul className={nested ? 'task-batch-children' : 'task-batch-nodes'}>
      {items.map((task) => (
        <li key={task.id} className="task-batch-node" data-task-id={task.id} {...(created.has(task.id) ? { 'data-created': 'true' } : {})}>
          {mark && <span className="task-batch-kind">{created.has(task.id) ? '新建' : '保留原任务'}</span>}
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
  if (state === 'executing') return '正在执行…';
  if (state === 'executed') return '已完成整组修改';
  if (state === 'failed') return '本组未修改';
  if (state === 'rejected') return '已拒绝，本组任务未修改。';
  if (state === 'superseded') return '此提议已被新的整组修改替代。';
  if (state === 'unknown') return '正在核对结果…';
  return '等待确认';
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
  const line = (change: Delta, field: Delta['fields'][number]) => {
    const name = change.before?.title ?? change.after.title;
    return `「${name}」${FIELD_LABELS[field.field] ?? field.field}：${fieldText(field.field, field.before, tasks)} → ${fieldText(field.field, field.after, tasks)}`;
  };
  return (
    <section className="task-batch-card" aria-label="整组任务修改" data-testid="task-batch-card" data-approval-id={approval.approvalId} data-state={state}>
      <h2 className="task-batch-title">确认整组任务修改</h2>
      <p className="task-batch-status" data-testid="batch-status" data-tone={state} {...(state === 'executing' ? { role: 'status', 'aria-live': 'polite' as const } : {})}>
        <StatusIcon />
        <span>{statusCopy(state)}</span>
      </p>
      {preview?.summary && <p className="task-batch-summary">{preview.summary}</p>}
      {preview && (
        <div className="task-batch-trees">
          <Tree title="修改前" testId="batch-before" tasks={preview.beforeTasks} labelFor={(task) => task.title} created={new Set()} mark={false} />
          <Tree title="修改后" testId="batch-after" tasks={preview.afterTasks} labelFor={afterLabel} created={created} mark />
        </div>
      )}
      {explicit.length > 0 && (
        <div className="task-batch-changes">
          <h3>修改内容</h3>
          <ul>
            {explicit.flatMap((change) => change.fields.map((field) => <li key={`${change.taskId}:${field.field}`}>{line(change, field)}</li>))}
          </ul>
        </div>
      )}
      {state === 'failed' && approval.outcome?.success === false && <p className="task-batch-alert" role="alert">{approval.outcome.error}</p>}
      <details className="task-batch-details">
        <summary>查看详细影响</summary>
        <ul>
          {related.flatMap((change) => change.fields.map((field) => <li key={`related:${change.taskId}:${field.field}`}>关联：{line(change, field)}</li>))}
          {(preview?.afterTasks ?? preview?.beforeTasks ?? []).map((task) => <li key={task.id}>{task.title} · {task.id} · 版本 {task.revision}</li>)}
        </ul>
      </details>
      {showActions && (
        <div className="task-batch-actions">
          <button type="button" className="task-batch-secondary" disabled={busy} onClick={() => { setPressed(true); onReject(approval.approvalId); }}>拒绝</button>
          <button type="button" className="task-batch-primary" disabled={busy} onClick={() => { setPressed(true); onApprove(approval.approvalId); }}>{busy ? '正在执行…' : '确认整组修改'}</button>
        </div>
      )}
    </section>
  );
}
