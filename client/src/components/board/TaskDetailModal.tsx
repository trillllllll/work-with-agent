import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
const fieldLabels: Record<string, string> = { title: '标题', description: '说明', status: '状态', priority: '优先级', dueDate: '截止日期', resultSummary: '结果摘要', topicId: '所属清单', parentId: '父任务', tagIds: '标签' };

export function TaskDetailModal({ id, topics, tags, onClose, onOpen, onSave, onCreate, onToggle, onMove, onDelete, onReorder }: Props) {
  const query = useTask(id);
  const task = query.data;
  const allTasks = useTasks(task?.topic?.archivedAt ? { includeArchived: 'true' } : {}, Boolean(task));
  const history = useQuery<TaskTopicHistory[]>({ queryKey: ['task-topic-history', id], queryFn: () => api(`/api/tasks/${id}/topic-history`) });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [leave, setLeave] = useState<{ next?: string } | null>(null);
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
  const finish = (next?: string) => { setLeave(null); next ? onOpen(next) : onClose(); };
  const requestLeave = (next?: string) => { if (saving) return; if (dirty) setLeave({ next }); else finish(next); };
  const update = (patch: Partial<TaskDraft>) => { setAcknowledgeConflict(false); setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current); };
  const save = async (close = false, next?: string) => {
    if (!task || !editing || lock.current) return;
    if (editing.conflicts.length && !acknowledgeConflict) { setLeave(null); return; }
    lock.current = true; setSaving(true);
    try {
      const patch = draftPatch(editing.base, editing.draft);
      const result = Object.keys(patch).length ? await onSave(task, patch) : task;
      if (!result) return;
      const current = taskDraft(result);
      setEditing({ base: current, draft: current, conflicts: [] });
      setAcknowledgeConflict(false);
      if (close) finish(next);
    } catch { /* Failed saves keep all fields available for retry. */ }
    finally { lock.current = false; setSaving(false); }
  };
  const readonly = Boolean(task?.topic?.archivedAt);
  const draft = editing?.draft;
  const selectClass = 'glass-control mt-2 h-10 w-full rounded-lg px-3 text-sm';
  return <>
    <Dialog open onOpenChange={(open) => { if (!open) requestLeave(); }}>
      <DialogContent surface="glass" className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>任务详情</DialogTitle><DialogDescription>{readonly ? '所属清单已归档，恢复清单后可以编辑。' : '编辑后点击保存；子任务和行内操作即时生效。'}</DialogDescription></DialogHeader>
        {query.isLoading || !draft ? <p>{query.error ? query.error.message : '正在加载…'}</p> : <>
          <form id="task-detail-form" onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
            {editing!.conflicts.length > 0 && <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><p>后台已更新{editing!.conflicts.map((field) => fieldLabels[field]).join('、')}，你的编辑已保留。</p><label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={acknowledgeConflict} onChange={(event) => setAcknowledgeConflict(event.target.checked)} />保存时使用我的编辑</label><Button type="button" variant="ghost" size="sm" onClick={() => { if (task) { const latest = taskDraft(task); setEditing({ base: latest, draft: latest, conflicts: [] }); } }}>使用最新内容</Button></div>}
            <fieldset disabled={readonly || saving} className="space-y-4 disabled:opacity-70">
              <div><Label htmlFor="task-detail-title">任务标题</Label><Input id="task-detail-title" required value={draft.title} onChange={(event) => update({ title: event.target.value })} className="mt-2" /></div>
              <div><Label htmlFor="task-detail-description">任务说明</Label><Textarea id="task-detail-description" value={draft.description} onChange={(event) => update({ description: event.target.value })} className="mt-2" /></div>
              <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="task-detail-status">状态</Label><select id="task-detail-status" aria-label="任务状态" className={selectClass} value={draft.status} onChange={(event) => update({ status: event.target.value as Task['status'] })}>{statuses.filter((item) => !task || availableTaskStatuses(task).includes(item.value)).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div><div><Label htmlFor="task-detail-priority">优先级</Label><select id="task-detail-priority" aria-label="优先级" className={selectClass} value={draft.priority} onChange={(event) => update({ priority: event.target.value as Task['priority'] })}>{priorities.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>
              <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="task-detail-due-date">截止日期</Label><Input id="task-detail-due-date" type="date" className="mt-2" value={draft.dueDate ?? ''} onChange={(event) => update({ dueDate: event.target.value || null })} /></div><div><Label htmlFor="task-detail-topic">所属清单</Label><select id="task-detail-topic" aria-label="所属清单" className={selectClass} value={draft.topicId ?? ''} onChange={(event) => update({ topicId: event.target.value || null, parentId: null })}><option value="">收集箱</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}{readonly && task?.topic && <option value={task.topic.id}>{task.topic.name}（已归档）</option>}</select></div></div>
              <div><Label htmlFor="task-detail-parent">父任务</Label><select id="task-detail-parent" aria-label="父任务" className={selectClass} value={draft.parentId ?? ''} onChange={(event) => update({ parentId: event.target.value || null })}><option value="">无（根任务）</option>{(allTasks.data ?? []).filter((candidate) => candidate.id !== id && !candidate.parentId && candidate.topicId === draft.topicId).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></div>
              <div><Label>标签</Label><div className="mt-2 flex flex-wrap gap-3">{!tags.length && <p className="text-xs text-muted-foreground">在标签页面创建标签后即可分配。</p>}{tags.map((tag) => <label key={tag.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={draft.tagIds?.includes(tag.id) ?? false} onChange={(event) => update({ tagIds: event.target.checked ? [...(draft.tagIds ?? []), tag.id] : draft.tagIds?.filter((value) => value !== tag.id) })} />{tag.name}</label>)}</div></div>
              <details><summary className="cursor-pointer text-sm text-muted-foreground">结果与归属历史</summary><div className="mt-3"><Label htmlFor="task-detail-result">结果摘要</Label><Textarea id="task-detail-result" value={draft.resultSummary} onChange={(event) => update({ resultSummary: event.target.value })} className="mt-2" /></div><div className="mt-3 space-y-2 text-xs text-muted-foreground">{(history.data ?? []).map((item) => <p key={item.id}>{item.fromTopic?.name ?? '收集箱'} → {item.toTopic?.name ?? '收集箱'} · {new Date(item.changedAt).toLocaleString()}</p>)}</div></details>
            </fieldset>
          </form>
          {!task?.parentId && <section className="space-y-3 border-t pt-4"><h2 className="text-sm font-semibold">子任务</h2><TaskList tasks={task?.children ?? (allTasks.data ?? []).filter((child) => child.parentId === id)} topics={topics} onOpen={(next) => requestLeave(next)} onToggle={onToggle} onMove={onMove} onDelete={onDelete} onReorder={readonly ? undefined : onReorder} readonly={readonly} />{!readonly && <QuickCapture key={`${task?.topicId}.${id}`} topicId={task?.topicId ?? null} parentId={id} onCreate={onCreate} />}</section>}
          {task && <details className="border-t pt-4"><summary className="cursor-pointer text-sm">关联资料与项目记忆</summary><div className="mt-3"><KnowledgePage key={`${task.id}:${task.topicId}`} topics={topics} initialTopicId={task.topicId ?? ''} taskId={task.id} /></div></details>}
          {task && !readonly && <details className="border-t pt-4"><summary className="cursor-pointer text-sm">交给 AI 与结果验收</summary><div className="mt-3"><HandoffPanel task={task} disabled={dirty || saving} /></div></details>}
          <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="outline" disabled={saving} onClick={() => requestLeave()}>关闭</Button>{!readonly && <Button type="submit" form="task-detail-form" disabled={saving || !dirty || Boolean(editing!.conflicts.length && !acknowledgeConflict)}>{saving ? '正在保存…' : '保存更改'}</Button>}</div>
        </>}
      </DialogContent>
    </Dialog>
    {leave && <Dialog open onOpenChange={(open) => { if (!open) setLeave(null); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>保存未完成的编辑？</DialogTitle><DialogDescription>任务有未保存的更改。</DialogDescription></DialogHeader><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setLeave(null)}>继续编辑</Button><Button variant="outline" onClick={() => finish(leave.next)}>舍弃更改</Button><Button disabled={saving} onClick={() => { void save(true, leave.next); }}>保存并继续</Button></div></DialogContent></Dialog>}
  </>;
}
