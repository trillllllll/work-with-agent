import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, availableTaskStatuses, priorities, statuses, type Tag, type Task, type TaskTopicHistory, type Topic } from '@/lib/api.js';
import { draftPatch, mergeTaskDraft, taskDraft, type TaskDraft } from '@/lib/todo.js';
import { useTask, useTasks } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { QuickCapture } from '@/components/tasks/QuickCapture.js';
import { TaskList } from '@/components/tasks/TaskList.js';
import { HandoffPanel } from '@/components/workspace/HandoffPanel.js';
import { KnowledgePage } from '@/components/workspace/KnowledgePage.js';

type Props = { id: string; topics: Topic[]; tags: Tag[]; onClose: () => void; onOpen: (id: string) => void; onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>; onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>; onToggle: (task: Task) => Promise<unknown>; onMove: (task: Task, topicId: string | null) => Promise<unknown>; onDelete: (task: Task) => void; onReorder: (tasks: Task[], parentId: string | null) => Promise<unknown>; };
type Editing = { base: TaskDraft; draft: TaskDraft; conflicts: string[] };
export type TaskDetailHandle = { requestTransition: (action: () => void) => void };
const fieldLabels: Record<string, string> = { title: '标题', description: '说明', status: '状态', priority: '优先级', dueDate: '截止日期', resultSummary: '结果摘要', topicId: '所属清单', parentId: '父任务', tagIds: '标签' };

const TaskDetailEditor = forwardRef<TaskDetailHandle, Props & { presentation: 'panel' | 'modal' }>(function TaskDetailEditor({ id, topics, tags, onClose, onOpen, onSave, onCreate, onToggle, onMove, onDelete, onReorder, presentation }, ref) {
  const query = useTask(id);
  const task = query.data;
  const allTasks = useTasks(task?.topic?.archivedAt ? { includeArchived: 'true' } : {}, Boolean(task));
  const history = useQuery<TaskTopicHistory[]>({ queryKey: ['task-topic-history', id], queryFn: () => api(`/api/tasks/${id}/topic-history`) });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [acknowledgeConflict, setAcknowledgeConflict] = useState(false);
  const lock = useRef(false);

  useEffect(() => {
    if (!task) return;
    const incoming = taskDraft(task);
    setEditing((current) => {
      if (!current) return { base: incoming, draft: incoming, conflicts: [] };
      const merged = mergeTaskDraft(current.base, current.draft, incoming);
      return { base: incoming, draft: merged.draft, conflicts: [...new Set([...current.conflicts, ...merged.conflicts])] };
    });
  }, [task]);

  const dirty = Boolean(editing && Object.keys(draftPatch(editing.base, editing.draft)).length);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const requestTransition = (action: () => void) => {
    if (saving) return;
    if (dirty) setLeaveAction(() => action);
    else action();
  };
  useImperativeHandle(ref, () => ({ requestTransition }), [dirty, saving]);

  const update = (patch: Partial<TaskDraft>) => {
    setAcknowledgeConflict(false);
    setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
  };
  const resetDraft = () => {
    if (!task) return;
    const latest = taskDraft(task);
    setEditing({ base: latest, draft: latest, conflicts: [] });
    setAcknowledgeConflict(false);
  };
  const completeTransition = (action?: () => void) => { setLeaveAction(null); action?.(); };
  const save = async (afterSave?: () => void) => {
    if (!task || !editing || lock.current) return;
    if (editing.conflicts.length && !acknowledgeConflict) { setLeaveAction(null); return; }
    lock.current = true; setSaving(true);
    try {
      const patch = draftPatch(editing.base, editing.draft);
      const result = Object.keys(patch).length ? await onSave(task, patch) : task;
      if (!result) return;
      const current = taskDraft(result);
      setEditing({ base: current, draft: current, conflicts: [] });
      setAcknowledgeConflict(false);
      completeTransition(afterSave);
    } catch { /* Failed saves keep every field available for retry. */ }
    finally { lock.current = false; setSaving(false); }
  };

  const readonly = Boolean(task?.topic?.archivedAt);
  const draft = editing?.draft;
  const selectClass = 'glass-control mt-2 h-10 w-full rounded-xl px-3 text-sm';
  const formId = `task-detail-form-${id}`;
  const content = query.isLoading || !draft ? <p className="p-5 text-sm text-muted-foreground">{query.error ? query.error.message : '正在加载…'}</p> : <>
    <div className="task-detail-scroll glass-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-5">
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void save(onClose); }} className="space-y-4">
        {editing!.conflicts.length > 0 && <div role="alert" className="rounded-xl border border-warning-border bg-warning-bg p-3 text-sm text-warning"><p>后台已更新{editing!.conflicts.map((field) => fieldLabels[field]).join('、')}，你的编辑已保留。</p><label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={acknowledgeConflict} onChange={(event) => setAcknowledgeConflict(event.target.checked)} />保存时使用我的编辑</label><Button type="button" variant="ghost" size="sm" onClick={resetDraft}>使用最新内容</Button></div>}
        <fieldset disabled={readonly || saving} className="space-y-4 disabled:opacity-70">
          <div><Label htmlFor={`task-detail-title-${id}`}>任务标题</Label><Input id={`task-detail-title-${id}`} required value={draft.title} onChange={(event) => update({ title: event.target.value })} className="mt-2 text-base font-semibold" /></div>
          <div><Label htmlFor={`task-detail-description-${id}`}>任务说明</Label><Textarea id={`task-detail-description-${id}`} value={draft.description} onChange={(event) => update({ description: event.target.value })} className="mt-2 min-h-24" /></div>
          <div className="grid grid-cols-2 gap-3"><div><Label htmlFor={`task-detail-status-${id}`}>状态</Label><select id={`task-detail-status-${id}`} aria-label="任务状态" className={selectClass} value={draft.status} onChange={(event) => update({ status: event.target.value as Task['status'] })}>{statuses.filter((item) => !task || availableTaskStatuses(task).includes(item.value)).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div><div><Label htmlFor={`task-detail-priority-${id}`}>优先级</Label><select id={`task-detail-priority-${id}`} aria-label="优先级" className={selectClass} value={draft.priority} onChange={(event) => update({ priority: event.target.value as Task['priority'] })}>{priorities.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>
          <div><Label htmlFor={`task-detail-due-date-${id}`}>截止日期</Label><Input id={`task-detail-due-date-${id}`} type="date" className="mt-2" value={draft.dueDate ?? ''} onChange={(event) => update({ dueDate: event.target.value || null })} /></div>
          <div><Label htmlFor={`task-detail-topic-${id}`}>所属清单</Label><select id={`task-detail-topic-${id}`} aria-label="所属清单" className={selectClass} value={draft.topicId ?? ''} onChange={(event) => update({ topicId: event.target.value || null, parentId: null })}><option value="">收集箱</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}{readonly && task?.topic && <option value={task.topic.id}>{task.topic.name}（已归档）</option>}</select></div>
          <div><Label htmlFor={`task-detail-parent-${id}`}>父任务</Label><select id={`task-detail-parent-${id}`} aria-label="父任务" className={selectClass} value={draft.parentId ?? ''} onChange={(event) => update({ parentId: event.target.value || null })}><option value="">无（根任务）</option>{(allTasks.data ?? []).filter((candidate) => candidate.id !== id && !candidate.parentId && candidate.topicId === draft.topicId).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></div>
          <div><Label>标签</Label><div className="mt-2 flex flex-wrap gap-2">{!tags.length && <p className="text-xs text-muted-foreground">在标签页面创建标签后即可分配。</p>}{tags.map((tag) => <label key={tag.id} className="task-tag-chip flex items-center gap-1.5" data-color={tag.color || 'violet'}><input type="checkbox" checked={draft.tagIds?.includes(tag.id) ?? false} onChange={(event) => update({ tagIds: event.target.checked ? [...(draft.tagIds ?? []), tag.id] : draft.tagIds?.filter((value) => value !== tag.id) })} />{tag.name}</label>)}</div></div>
          <details className="detail-section"><summary>结果与归属历史</summary><div className="mt-3"><Label htmlFor={`task-detail-result-${id}`}>结果摘要</Label><Textarea id={`task-detail-result-${id}`} value={draft.resultSummary} onChange={(event) => update({ resultSummary: event.target.value })} className="mt-2" /></div><div className="mt-3 space-y-2 text-xs text-muted-foreground">{(history.data ?? []).map((item) => <p key={item.id}>{item.fromTopic?.name ?? '收集箱'} → {item.toTopic?.name ?? '收集箱'} · {new Date(item.changedAt).toLocaleString()}</p>)}</div></details>
        </fieldset>
      </form>
      {!task?.parentId && <section className="mt-4 space-y-3 border-t pt-4"><h2 className="text-sm font-semibold">子任务</h2><TaskList tasks={task?.children ?? (allTasks.data ?? []).filter((child) => child.parentId === id)} topics={topics} onOpen={(next) => requestTransition(() => onOpen(next))} onToggle={onToggle} onMove={onMove} onDelete={onDelete} onReorder={readonly ? undefined : onReorder} readonly={readonly} />{!readonly && <QuickCapture key={`${task?.topicId}.${id}`} topicId={task?.topicId ?? null} parentId={id} onCreate={onCreate} />}</section>}
      {task && <details className="detail-section mt-4 border-t pt-4"><summary>关联资料与项目记忆</summary><div className="mt-3"><KnowledgePage key={`${task.id}:${task.topicId}`} topics={topics} initialTopicId={task.topicId ?? ''} taskId={task.id} /></div></details>}
      {task && !readonly && <details className="detail-section mt-4 border-t pt-4"><summary>交给 AI 与结果验收</summary><div className="mt-3"><HandoffPanel task={task} disabled={dirty || saving} /></div></details>}
    </div>
    <div className="glass-surface flex shrink-0 gap-2 border-x-0 border-b-0 p-4"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => requestTransition(onClose)}>关闭</Button>{!readonly && <Button type="submit" form={formId} className="flex-[1.5]" disabled={saving || !dirty || Boolean(editing!.conflicts.length && !acknowledgeConflict)}>{saving ? '正在保存…' : '保存更改'}</Button>}</div>
  </>;

  const titleBar = <header className="flex shrink-0 items-start justify-between gap-3 px-5 pb-4 pt-5"><div><h2 className="text-lg font-semibold">任务详情</h2><p className="mt-1 text-xs text-muted-foreground">{readonly ? '所属清单已归档，内容只读。' : '编辑字段后明确保存。'}</p></div><Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" onClick={() => requestTransition(onClose)}><X /></Button></header>;
  const leaveDialog = leaveAction && <Dialog open onOpenChange={(open) => { if (!open) setLeaveAction(null); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>保存未完成的编辑？</DialogTitle><DialogDescription>任务有未保存的更改。</DialogDescription></DialogHeader><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setLeaveAction(null)}>继续编辑</Button><Button variant="outline" onClick={() => { const action = leaveAction; resetDraft(); completeTransition(action); }}>舍弃更改</Button><Button disabled={saving} onClick={() => { void save(leaveAction); }}>保存并继续</Button></div></DialogContent></Dialog>;

  if (presentation === 'panel') return <><aside role="dialog" aria-modal="false" className="task-detail-panel glass-surface flex h-full min-h-0 flex-col border-y-0 border-r-0" aria-label="任务详情">{titleBar}{content}</aside>{leaveDialog}</>;
  return <><Dialog open onOpenChange={(open) => { if (!open) requestTransition(onClose); }}><DialogContent showCloseButton={false} surface="glass" className="flex max-h-[92dvh] flex-col overflow-hidden p-0 sm:max-w-2xl"><DialogTitle className="sr-only">任务详情</DialogTitle><DialogDescription className="sr-only">编辑任务内容并明确保存。</DialogDescription>{titleBar}{content}</DialogContent></Dialog>{leaveDialog}</>;
});

export const TaskDetailPanel = forwardRef<TaskDetailHandle, Props>(function TaskDetailPanel(props, ref) {
  return <TaskDetailEditor ref={ref} {...props} presentation="panel" />;
});

export const TaskDetailModal = forwardRef<TaskDetailHandle, Props>(function TaskDetailModal(props, ref) {
  return <TaskDetailEditor ref={ref} {...props} presentation="modal" />;
});
