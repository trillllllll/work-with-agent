import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { t } from '../i18n/index.js';
import { api } from './api.js';

function labels<K extends string>(keys: Record<K, string>): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const id of Object.keys(keys) as K[]) {
    const key = keys[id];
    Object.defineProperty(result, id, { enumerable: true, get: () => t(key) });
  }
  return result;
}

export type Command = { kind: string; targetId?: string; expectedRevision?: number; input?: Record<string, unknown>; clientRef?: string };
export type CommandResult = { status: 'applied' | 'pending_approval'; proposalId?: string; results?: any[]; changeId?: string };
export async function submitCommands(commands: Command[], requestId: string = crypto.randomUUID()) {
  return api<CommandResult>('/api/v1/commands', { method: 'POST', body: JSON.stringify({ requestId, commands }) });
}
export const json = (value: unknown) => JSON.stringify(value);
export function parseStored<T>(value: T | string | undefined | null, fallback: T): T {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
export function usePlatformAction() {
  const { t } = useTranslation('app');
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const run = async <T,>(work: () => Promise<T>, message = t('action.saved')): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const result = await work();
      await client.invalidateQueries();
      const changeId = (result as any)?.changeId;
      toast.success((result as any)?.status === 'pending_approval' ? t('action.pendingApproval') : message, changeId ? { duration: 8000, action: { label: t('action.undo'), onClick: () => { void api(`/api/changes/${changeId}/undo`, { method: 'POST', body: '{}', headers: { 'X-Request-ID': crypto.randomUUID() } }).then(() => { void client.invalidateQueries(); toast.success(t('action.undone')); }).catch((error) => toast.error(error.message)); } } } : undefined);
      return result;
    } catch (error) { toast.error(error instanceof Error ? error.message : t('action.failed')); return undefined; }
    finally { lock.current = false; setBusy(false); }
  };
  return { run, busy };
}

export const operationNames: Record<string, string> = labels({
  'task.create': 'app:operation.taskCreate', 'task.update': 'app:operation.taskUpdate', 'task.delete': 'app:operation.taskDelete', 'task.restore': 'app:operation.taskRestore', 'task.reorder': 'app:operation.taskReorder',
  'topic.create': 'app:operation.topicCreate', 'topic.update': 'app:operation.topicUpdate', 'topic.archive': 'app:operation.topicArchive', 'topic.restore': 'app:operation.topicRestore',
  'material.create': 'app:operation.materialCreate', 'material.update': 'app:operation.materialUpdate', 'material.archive': 'app:operation.materialArchive',
  'material.replace': 'app:operation.materialReplace', 'material.organize': 'app:operation.materialOrganize', 'material.links': 'app:operation.materialLinks', 'material.reextract': 'app:operation.materialReextract',
  'libraryFolder.create': 'app:operation.libraryFolderCreate', 'libraryFolder.update': 'app:operation.libraryFolderUpdate', 'libraryFolder.delete': 'app:operation.libraryFolderDelete',
  'libraryTag.create': 'app:operation.libraryTagCreate', 'libraryTag.update': 'app:operation.libraryTagUpdate', 'libraryTag.delete': 'app:operation.libraryTagDelete',
  'task.reference_materials': 'app:operation.taskReferenceMaterials',
  'memory.create': 'app:operation.memoryCreate', 'memory.update': 'app:operation.memoryUpdate', 'memory.retire': 'app:operation.memoryRetire', 'memory.crystallize': 'app:operation.memoryCrystallize',
  'skill.create': 'app:operation.skillCreate', 'skill.update': 'app:operation.skillUpdate',
  'entity.create': 'app:operation.entityCreate', 'entity.update': 'app:operation.entityUpdate', 'entity.delete': 'app:operation.entityDelete', 'graph.link': 'app:operation.graphLink', 'graph.unlink': 'app:operation.graphUnlink',
  create_task: 'app:operation.taskCreate', update_task: 'app:operation.taskUpdate', delete_task: 'app:operation.taskDelete', restore_task: 'app:operation.taskRestore', reorder_tasks: 'app:operation.taskReorder',
  create_topic: 'app:operation.topicCreate', update_topic: 'app:operation.topicUpdate', archive_topic: 'app:operation.topicArchive', restore_topic: 'app:operation.topicRestore',
  create_material: 'app:operation.createMaterial', update_material: 'app:operation.updateMaterial', archive_material: 'app:operation.archiveMaterial',
  create_memory: 'app:operation.memoryCreate', update_memory: 'app:operation.memoryUpdate', invalidate_memory: 'app:operation.invalidateMemory', supersede_memory: 'app:operation.supersedeMemory',
});
