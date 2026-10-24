import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, apiMutation, ApiError, type ApiEnvelope, type ChangePage, type FocusSession, type Task } from '@/lib/api.js';
import { markChangeUndone } from '@/lib/change-list-cache.js';
import { enqueueWrite, localDate, queryKeys, keepNewestTask } from '@/lib/todo.js';
import { useCommandPreview, type CommandPreview } from '@/components/dialogs/CommandPreviewProvider.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';

export function invalidateTodo(client: QueryClient) {
  return Promise.all(['tasks', 'task', 'topics', 'topic', 'tags', 'trash', 'changes', 'task-topic-history'].map((key) => client.invalidateQueries({ queryKey: [key] })));
}
const TASK_SCOPE = ['tasks', 'task', 'changes'] as const;
const FULL_SCOPE = ['tasks', 'task', 'topics', 'topic', 'tags', 'trash', 'changes', 'task-topic-history'] as const;
const UNDO_SCOPE = [...FULL_SCOPE, 'library', 'knowledge', 'knowledge-tree', 'knowledge-graph', 'auto-memory', 'skills', 'skill', 'proposals', 'task-activity'] as const;
/** 写入成功后的失效范围：常规任务编辑只刷任务相关查询，结构性变更再带上对应实体。 */
function invalidationScope(path: string, body: Record<string, unknown>): readonly string[] {
  if (/^\/api\/changes\/[^/]+\/undo$/.test(path)) return UNDO_SCOPE;
  const structural = body.topicId !== undefined || body.parentId !== undefined;
  if (path.startsWith('/api/tasks/reorder')) return TASK_SCOPE;
  if (/^\/api\/tasks\/[^/]+$/.test(path)) {
    if (structural) return [...TASK_SCOPE, 'topics', 'topic', 'task-topic-history'];
    return TASK_SCOPE;
  }
  if (path.startsWith('/api/tasks')) return [...TASK_SCOPE, 'trash'];
  if (path.startsWith('/api/topics')) return ['topics', 'topic', 'tasks', 'task', 'task-topic-history', 'changes', 'trash'];
  if (path.startsWith('/api/tags')) return ['tags', 'tasks', 'task', 'changes'];
  if (path.startsWith('/api/trash')) return ['trash', 'tasks', 'task', 'changes'];
  return FULL_SCOPE;
}
export function useTasks(params: Record<string, string>, enabled = true) {
  const query = new URLSearchParams(params).toString();
  return useQuery<Task[]>({ queryKey: queryKeys.taskList(query), queryFn: ({ signal }) => api(`/api/tasks?${query}`, { signal }), enabled });
}
export function useTask(id: string) {
  return useQuery<Task>({ queryKey: queryKeys.task(id), queryFn: ({ signal }) => api(`/api/tasks/${id}?includeArchived=true`, { signal }), enabled: Boolean(id), structuralSharing: (old, next) => keepNewestTask(old as Task | undefined, next as Task) });
}
export function useLocalDate() {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const refresh = () => setToday(localDate());
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return today;
}
export function useTodoActions() {
  const editor = useEditorRuntime();
  const { t } = useTranslation('app');
  const client = useQueryClient();
  const confirmPreview = useCommandPreview();
  const [pending, setPending] = useState(0);
  const localPending = useRef(new Map<string, number>());
  const localVersions = useRef(new Map<string, Map<number, number>>());
  async function write<T = any>(path: string, method: string, body?: unknown, keys: string[] = [], message?: string): Promise<ApiEnvelope<T>> {
    // Capture the revision the user saw, before entering the write queue.
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const entityMatch = path.match(/^\/api\/(tasks|topics|tags|trash\/tasks)\/([^/]+)/);
    const id = entityMatch?.[2];
    const findCached = (entityId: string): any => {
      const values = client.getQueriesData({}).map(([, value]) => value);
      const visit = (value: any): any => value?.id === entityId ? value : Array.isArray(value) ? value.map(visit).find(Boolean) : value?.children ? visit(value.children) : undefined;
      return values.map(visit).filter(Boolean).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
    };
    const cached = id ? findCached(id) : undefined;
    const revision = record.expectedRevision ?? cached?.revision;
    const requestBody = { ...record, ...(revision !== undefined ? { expectedRevision: revision } : {}) };
    const requestId = crypto.randomUUID();
    const followsLocalWrite = Boolean(id && localPending.current.get(id));
    if (id) localPending.current.set(id, (localPending.current.get(id) ?? 0) + 1);
    setPending((value) => value + 1);
    try {
      const response = await enqueueWrite(keys, async () => {
        // A list snapshot can lag the text-save response, even after the detail has closed.
        // Only bridge this editor's acknowledged text writes; remote revisions still conflict.
        const textOnlyAdvance = /^\/api\/tasks\/[^/]+$/.test(path) && method === 'PATCH' && record.title === undefined && record.description === undefined;
        if (id && textOnlyAdvance && typeof requestBody.expectedRevision === 'number') requestBody.expectedRevision = editor?.textSaves.advance(id, requestBody.expectedRevision) ?? requestBody.expectedRevision;
        // Advance only across successful writes already queued by this client.
        // A server refresh or another actor's write never supplies this version.
        if (id && followsLocalWrite && typeof requestBody.expectedRevision === 'number') {
          const versions = localVersions.current.get(id);
          let previous: number;
          do {
            previous = requestBody.expectedRevision;
            requestBody.expectedRevision = versions?.get(previous) ?? previous;
            if (textOnlyAdvance) requestBody.expectedRevision = editor?.textSaves.advance(id, requestBody.expectedRevision) ?? requestBody.expectedRevision;
          } while (requestBody.expectedRevision !== previous);
        }
        let result: ApiEnvelope<T>;
        try { result = await apiMutation<T>(path, { method, headers: { 'X-Request-ID': requestId }, body: JSON.stringify(requestBody) }); }
        catch (error) {
          const commands = error instanceof ApiError && error.code === 'PREVIEW_REQUIRED' ? (error.details as { commands?: unknown[] })?.commands : undefined;
          if (!commands) throw error;
          // Preserve the user's original object version while freezing every cascade member.
          const preview = await api<CommandPreview>('/api/v1/commands/preview', { method: 'POST', body: JSON.stringify({ requestId, commands }) });
          if (preview.requiresConfirmation && !await confirmPreview(preview)) throw new ApiError(t('action.cancelled'), 'USER_CANCELLED');
          result = await apiMutation<T>(path, { method, headers: { 'X-Request-ID': requestId }, body: JSON.stringify({ ...requestBody, previewToken: preview.previewToken }) });
        }
        const task = result.data as Task | null;
        if (task?.id && typeof task.title === 'string') {
          if (id === task.id && typeof requestBody.expectedRevision === 'number' && task.revision !== undefined && task.revision > requestBody.expectedRevision) {
            const versions = localVersions.current.get(id) ?? new Map<number, number>();
            versions.set(requestBody.expectedRevision, task.revision);
            localVersions.current.set(id, versions);
          }
          await Promise.all([client.cancelQueries({ queryKey: queryKeys.task(task.id) }), client.cancelQueries({ queryKey: queryKeys.tasks })]);
          const merge = (old: Task | undefined) => keepNewestTask(old, { ...old, ...task });
          client.setQueryData<Task>(queryKeys.task(task.id), merge);
          client.setQueriesData<Task[]>({ queryKey: queryKeys.tasks }, (old) => Array.isArray(old) ? old.map((item) => item.id === task.id ? merge(item) : item) : old);
        }
        const undoId = path.match(/^\/api\/changes\/([^/]+)\/undo$/)?.[1];
        if (undoId) client.setQueriesData<InfiniteData<ChangePage>>({ queryKey: ['changes', 'page'] }, (current) => markChangeUndone(current, undoId, new Date().toISOString()));
        await Promise.all(invalidationScope(path, record).map((key) => client.invalidateQueries({ queryKey: [key] })));
        return result;
      });
      response.meta?.warnings?.forEach((warning) => toast.info(warning));
      const canUndo = response.meta?.changeId && !/\/(undo|permanent)$/.test(path);
      if (message) toast.success(message, canUndo ? {
        duration: 8000,
        action: { label: t('action.undo'), onClick: () => { void write(`/api/changes/${response.meta!.changeId}/undo`, 'POST', undefined, response.meta?.affectedTaskIds ?? keys, t('action.undone')).catch(() => undefined); } },
      } : undefined);
      return response;
    } catch (error) {
      // Completion confirmation is handled by the caller and must not also show an error toast.
      if (error instanceof Error && 'code' in error && ['VERSION_CONFLICT', 'CONFLICT', 'PRECONDITION_FAILED'].includes(String(error.code))) await invalidateTodo(client);
      if (!(error instanceof Error && 'code' in error && ['SUBTASKS_INCOMPLETE', 'USER_CANCELLED'].includes(String(error.code)))) toast.error(error instanceof Error ? error.message : t('action.failed'));
      throw error;
    } finally {
      if (id) {
        const remaining = (localPending.current.get(id) ?? 1) - 1;
        if (remaining) localPending.current.set(id, remaining);
        else { localPending.current.delete(id); localVersions.current.delete(id); }
      }
      setPending((value) => value - 1);
    }
  }
  const patch = (id: string, changes: unknown, relatedIds: string[] = []) => write<Task>(`/api/tasks/${id}`, 'PATCH', changes, [id, ...relatedIds], t('todo.taskUpdated'));
  const create = (input: unknown, parentId?: string | null) => write<Task>('/api/tasks', 'POST', input, parentId ? [parentId] : [], t('todo.taskCreated'));
  return { write, patch, create, pending: pending > 0 };
}

export function useFocusSessions(params: { taskId?: string; from?: string; to?: string } = {}) {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return useQuery<FocusSession[]>({ queryKey: [...queryKeys.focusSessions, query], queryFn: ({ signal }) => api(`/api/focus-sessions${query ? `?${query}` : ''}`, { signal }) });
}
export function useRecordFocusSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string | null; kind: 'focus' | 'break'; startedAt: string; endedAt: string; durationMinutes: number; plannedMinutes: number; completed: boolean }) =>
      apiMutation<FocusSession>('/api/focus-sessions', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.focusSessions }); },
  });
}
