import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { History, Undo2 } from 'lucide-react';
import { api, type ChangeRecord, type Tag, type Task, type Topic } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { useTodoActions } from '@/hooks/useTodo.js';

const labels: Record<string, string> = { create: '创建', update: '更新', delete: '删除', archive: '归档主题（旧行为）', archive_preserve: '归档清单', reorder: '调整顺序', move_tasks_to_inbox: '移入收集箱', restore: '恢复', permanent_delete: '永久删除', confirm_summary: '确认成果', discard_summary: '放弃成果', execute: '受控执行', undo: '撤销' };
const entityLabels: Record<string, string> = { topic: '清单', task: '任务', tag: '标签', execution: '受控执行' };
function operationLabel(operation: string) { return operation.startsWith('undo:') ? `撤销：${labels[operation.slice(5)] ?? operation.slice(5)}` : labels[operation] ?? operation; }
function summary(record: ChangeRecord) {
  const snapshots = [record.afterSnapshot, record.beforeSnapshot].flatMap((raw) => { if (!raw) return []; try { return [JSON.parse(raw)]; } catch { return []; } });
  for (const value of snapshots) {
    if (value?.version === 2 && value.entities) {
      const entities = ['tasks', 'topics', 'tags'].flatMap((kind) => Object.entries(value.entities[kind] ?? {}));
      const primary = entities.find(([id, entity]) => id === record.entityId && entity)?.[1] as { title?: string; name?: string } | undefined;
      if (!primary && entities.some(([id, entity]) => id === record.entityId && !entity)) continue;
      const first = primary ?? entities.find(([, entity]) => entity)?.[1] as { title?: string; name?: string } | undefined;
      if (first?.title || first?.name) return `${first.title || first.name}${entities.length > 1 ? ` · 同组 ${entities.length} 个对象` : ''}`.slice(0, 120);
    } else {
      const text = value?.title || value?.name || value?.finalSummary || value?.draftSummary || (value?.toolName ? `${value.toolName} · ${value.result?.success ? '成功' : '失败'}` : '');
      if (text) return String(text).slice(0, 120);
    }
  }
  return '';
}

// Snapshots include deleted and archived tasks that the daily task query omits.
// Keep the group locked through the shared mutation's cache refresh as well.
function undoKeys(record: ChangeRecord, activeTasks: Task[]) {
  const keys = new Set([record.entityId, ...activeTasks.map((task) => task.id)]);
  const addTask = (task: any) => {
    if (typeof task?.id === 'string') keys.add(task.id);
    if (typeof task?.parentId === 'string') keys.add(task.parentId);
  };
  for (const raw of [record.beforeSnapshot, record.afterSnapshot]) {
    if (!raw) continue;
    try {
      const snapshot = JSON.parse(raw);
      if (snapshot?.version === 2 && snapshot.entities) {
        for (const [id, task] of Object.entries(snapshot.entities.tasks ?? {})) { keys.add(id); addTask(task); }
        for (const kind of ['topics', 'tags']) Object.keys(snapshot.entities[kind] ?? {}).forEach((id) => keys.add(id));
      } else if (snapshot) {
        if (record.entityType === 'task') addTask(snapshot);
        addTask(snapshot.task);
        const archivedTasks = snapshot.tasks;
        if (Array.isArray(archivedTasks)) archivedTasks.forEach(addTask);
        else if (archivedTasks && typeof archivedTasks === 'object') {
          for (const [id, task] of Object.entries(archivedTasks)) { keys.add(id); addTask(task); }
        }
      }
    } catch { /* The service validates legacy snapshots; keep the known keys locked. */ }
  }
  return [...keys];
}

export function ChangesPage() {
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const actions = useTodoActions();
  const records = useQuery<ChangeRecord[]>({ queryKey: ['changes', entityType, entityId], queryFn: () => api(`/api/changes?${new URLSearchParams({ ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) })}`) });
  const topics = useQuery<Topic[]>({ queryKey: ['topics'], queryFn: () => api('/api/topics') });
  const tasks = useQuery<Task[]>({ queryKey: ['tasks'], queryFn: () => api('/api/tasks') });
  const tags = useQuery<Tag[]>({ queryKey: ['tags'], queryFn: () => api('/api/tags') });
  const names = useMemo(() => new Map([...(topics.data ?? []).map((item) => [item.id, item.name] as const), ...(tasks.data ?? []).map((item) => [item.id, item.title] as const), ...(tags.data ?? []).map((item) => [item.id, item.name] as const)]), [topics.data, tasks.data, tags.data]);
  const undo = useMutation({ mutationFn: (record: ChangeRecord) => actions.write(`/api/changes/${record.id}/undo`, 'POST', undefined, undoKeys(record, tasks.data ?? []), '变更已撤销') });
  return <div className="min-h-full p-5 sm:p-8"><header className="glass-divider border-b pb-5"><div className="flex items-center gap-2"><History className="size-5 text-primary" /><div><span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">审计</span><h1 className="mt-1 text-2xl font-semibold tracking-tight">变更历史</h1></div></div><p className="mt-2 text-[13px] text-muted-foreground">查看工作区变更，并撤销仍然安全可逆的操作。</p></header><div className="mt-5 flex flex-wrap gap-2"><Select value={entityType || 'all'} onValueChange={(value) => setEntityType(value === 'all' ? '' : value)}><SelectTrigger className="h-9 w-[9rem] rounded-xl text-sm" aria-label="筛选对象类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部对象</SelectItem><SelectItem value="topic">清单</SelectItem><SelectItem value="tag">标签</SelectItem><SelectItem value="task">任务</SelectItem><SelectItem value="execution">受控执行</SelectItem></SelectContent></Select><input className="glass-control h-9 rounded-xl px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="按对象 ID 筛选" value={entityId} onChange={(e) => setEntityId(e.target.value)} /></div><div className="mt-5 flex flex-col gap-3">{records.isLoading ? <p className="py-10 text-center text-sm text-muted-foreground">正在加载历史…</p> : !(records.data ?? []).length ? <p className="py-10 text-center text-sm text-muted-foreground">暂无变更记录</p> : records.data!.map((record) => { const canUndo = !record.undoneAt && record.reversible && Boolean(record.beforeSnapshot || record.afterSnapshot); return <article key={record.id} className="glass-subtle rounded-2xl p-4"><div className="flex items-start justify-between gap-3 max-md:flex-col"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{operationLabel(record.operation)}</strong><span className="text-xs text-muted-foreground">{entityLabels[record.entityType] ?? record.entityType} · {names.get(record.entityId) ?? record.entityId}</span></div><p className="mt-1 text-xs text-muted-foreground">{new Date(record.createdAt).toLocaleString()} · {record.source === 'agent' ? 'Agent' : '用户'}{record.approvalId ? ` · 审核 ${record.approvalId}` : ''}</p>{summary(record) && <p className="mt-2 truncate text-sm">{summary(record)}</p>}</div>{canUndo ? <Button size="sm" variant="outline" disabled={undo.isPending} onClick={() => undo.mutate(record)}><Undo2 />撤销</Button> : <span className="text-xs text-muted-foreground">{record.undoneAt ? '已撤销' : '不可撤销'}</span>}</div></article>; })}</div></div>;
}
