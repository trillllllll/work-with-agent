import { usePageContext } from '@/lib/assistant-context.js';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { History, Undo2 } from 'lucide-react';
import { api, type ChangeRecord, type Tag, type Task, type Topic } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { useTodoActions } from '@/hooks/useTodo.js';

const operationIds = ['create', 'update', 'delete', 'archive', 'archive_preserve', 'reorder', 'move_tasks_to_inbox', 'restore', 'permanent_delete', 'confirm_summary', 'discard_summary', 'execute', 'undo'] as const;
const entityIds = ['topic', 'task', 'tag', 'execution'] as const;
function operationLabel(operation: string, t: TFunction<'settings'>) {
  const undo = operation.startsWith('undo:');
  const id = undo ? operation.slice(5) : operation;
  const label = (operationIds as readonly string[]).includes(id) ? t(`changes.operations.${id}`) : id;
  return undo ? t('changes.undoOf', { operation: label }) : label;
}
function entityLabel(entityType: string, t: TFunction<'settings'>) {
  return (entityIds as readonly string[]).includes(entityType) ? t(`changes.entities.${entityType}`) : entityType;
}
function summary(record: ChangeRecord, t: TFunction<'settings'>) {
  const snapshots = [record.afterSnapshot, record.beforeSnapshot].flatMap((raw) => { if (!raw) return []; try { return [JSON.parse(raw)]; } catch { return []; } });
  for (const value of snapshots) {
    if (value?.version === 2 && value.entities) {
      const entities = ['tasks', 'topics', 'tags'].flatMap((kind) => Object.entries(value.entities[kind] ?? {}));
      const primary = entities.find(([id, entity]) => id === record.entityId && entity)?.[1] as { title?: string; name?: string } | undefined;
      if (!primary && entities.some(([id, entity]) => id === record.entityId && !entity)) continue;
      const first = primary ?? entities.find(([, entity]) => entity)?.[1] as { title?: string; name?: string } | undefined;
      if (first?.title || first?.name) return `${first.title || first.name}${entities.length > 1 ? t('changes.groupSuffix', { count: entities.length }) : ''}`.slice(0, 120);
    } else {
      const text = value?.title || value?.name || value?.finalSummary || value?.draftSummary || (value?.toolName ? t(value.result?.success ? 'changes.toolSuccess' : 'changes.toolFailure', { toolName: value.toolName }) : '');
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
  const { t } = useTranslation('settings');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  usePageContext('changes', { pageState: { kind: entityType, selectedId: entityId } });
  const actions = useTodoActions();
  const records = useQuery<ChangeRecord[]>({ queryKey: ['changes', entityType, entityId], queryFn: () => api(`/api/changes?${new URLSearchParams({ ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) })}`) });
  const topics = useQuery<Topic[]>({ queryKey: ['topics'], queryFn: () => api('/api/topics') });
  const tasks = useQuery<Task[]>({ queryKey: ['tasks'], queryFn: () => api('/api/tasks') });
  const tags = useQuery<Tag[]>({ queryKey: ['tags'], queryFn: () => api('/api/tags') });
  const names = useMemo(() => new Map([...(topics.data ?? []).map((item) => [item.id, item.name] as const), ...(tasks.data ?? []).map((item) => [item.id, item.title] as const), ...(tags.data ?? []).map((item) => [item.id, item.name] as const)]), [topics.data, tasks.data, tags.data]);
  const undo = useMutation({ mutationFn: (record: ChangeRecord) => actions.write(`/api/changes/${record.id}/undo`, 'POST', undefined, undoKeys(record, tasks.data ?? []), t('changes.undoneToast')) });
  return <div className="min-h-full p-5 sm:p-8"><header className="glass-divider border-b pb-5"><div className="flex items-center gap-2"><History className="size-5 text-primary" /><div><span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">{t('changes.eyebrow')}</span><h1 className="mt-1 text-2xl font-semibold tracking-tight">{t('changes.title')}</h1></div></div><p className="mt-2 text-[13px] text-muted-foreground">{t('changes.description')}</p></header><div className="mt-5 flex flex-wrap gap-2"><Select value={entityType || 'all'} onValueChange={(value) => setEntityType(value === 'all' ? '' : value)}><SelectTrigger className="h-9 w-[9rem] rounded-xl text-sm" aria-label={t('changes.filterType')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('changes.allObjects')}</SelectItem><SelectItem value="topic">{entityLabel('topic', t)}</SelectItem><SelectItem value="tag">{entityLabel('tag', t)}</SelectItem><SelectItem value="task">{entityLabel('task', t)}</SelectItem><SelectItem value="execution">{entityLabel('execution', t)}</SelectItem></SelectContent></Select><input className="glass-control h-9 rounded-xl px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50" placeholder={t('changes.filterById')} value={entityId} onChange={(e) => setEntityId(e.target.value)} /></div><div className="mt-5 flex flex-col gap-3">{records.isLoading ? <p className="py-10 text-center text-sm text-muted-foreground">{t('changes.loading')}</p> : !(records.data ?? []).length ? <p className="py-10 text-center text-sm text-muted-foreground">{t('changes.empty')}</p> : records.data!.map((record) => { const canUndo = !record.undoneAt && record.reversible && Boolean(record.beforeSnapshot || record.afterSnapshot); return <article key={record.id} className="glass-subtle rounded-2xl p-4"><div className="flex items-start justify-between gap-3 max-md:flex-col"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{operationLabel(record.operation, t)}</strong><span className="text-xs text-muted-foreground">{entityLabel(record.entityType, t)} · {names.get(record.entityId) ?? record.entityId}</span></div><p className="mt-1 text-xs text-muted-foreground">{new Date(record.createdAt).toLocaleString(intlLocale())} · {record.source === 'agent' ? 'Agent' : t('changes.user')}{record.approvalId ? t('changes.approvalSuffix', { id: record.approvalId }) : ''}</p>{summary(record, t) && <p className="mt-2 truncate text-sm">{summary(record, t)}</p>}</div>{canUndo ? <Button size="sm" variant="outline" disabled={undo.isPending} onClick={() => undo.mutate(record)}><Undo2 />{t('changes.undo')}</Button> : <span className="text-xs text-muted-foreground">{record.undoneAt ? t('changes.undone') : t('changes.notReversible')}</span>}</div></article>; })}</div></div>;
}
