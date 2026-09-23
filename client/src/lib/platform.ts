import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api.js';

export type Command = { kind: string; targetId?: string; expectedRevision?: number; input?: Record<string, unknown>; clientRef?: string };
export type CommandResult = { status: 'applied' | 'pending_approval'; proposalId?: string; results?: any[]; changeId?: string };
export async function submitCommands(commands: Command[], requestId = crypto.randomUUID()) {
  return api<CommandResult>('/api/v1/commands', { method: 'POST', body: JSON.stringify({ requestId, commands }) });
}
export const json = (value: unknown) => JSON.stringify(value);
export function parseStored<T>(value: T | string | undefined | null, fallback: T): T {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
export function usePlatformAction() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const run = async <T,>(work: () => Promise<T>, message = '已保存'): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const result = await work();
      await client.invalidateQueries();
      const changeId = (result as any)?.changeId;
      toast.success((result as any)?.status === 'pending_approval' ? '已加入待确认' : message, changeId ? { duration: 8000, action: { label: '撤销', onClick: () => { void api(`/api/changes/${changeId}/undo`, { method: 'POST', body: '{}', headers: { 'X-Request-ID': crypto.randomUUID() } }).then(() => { void client.invalidateQueries(); toast.success('已撤销'); }).catch((error) => toast.error(error.message)); } } } : undefined);
      return result;
    } catch (error) { toast.error(error instanceof Error ? error.message : '操作失败'); return undefined; }
    finally { lock.current = false; setBusy(false); }
  };
  return { run, busy };
}

export const operationNames: Record<string, string> = {
  'task.create': '创建任务', 'task.update': '修改任务', 'task.delete': '删除任务', 'task.restore': '恢复任务', 'task.reorder': '调整任务顺序',
  'topic.create': '创建清单', 'topic.update': '修改清单', 'topic.archive': '归档清单', 'topic.restore': '恢复清单',
  'material.create': '保存材料', 'material.update': '修订材料', 'material.archive': '调整材料归档',
  'memory.create': '保存记忆', 'memory.update': '修订记忆', 'memory.retire': '保留为历史记忆', 'memory.crystallize': '沉淀结晶记忆',
  'entity.create': '建立实体', 'entity.update': '修订实体', 'entity.delete': '删除实体', 'graph.link': '建立关系', 'graph.unlink': '移除关系',
  create_task: '创建任务', update_task: '修改任务', delete_task: '删除任务', restore_task: '恢复任务', reorder_tasks: '调整任务顺序',
  create_topic: '创建清单', update_topic: '修改清单', archive_topic: '归档清单', restore_topic: '恢复清单',
  create_material: '保存资料', update_material: '修订资料', archive_material: '归档资料',
  create_memory: '保存记忆', update_memory: '修订记忆', invalidate_memory: '使记忆失效', supersede_memory: '替代记忆',
};
