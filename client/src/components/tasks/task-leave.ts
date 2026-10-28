import { sameField, type TaskDraft } from '@/lib/todo.js';

export const metaFields = ['status', 'priority', 'dueDate', 'estimatedMinutes', 'scheduledStart', 'scheduledEnd', 'resultSummary', 'recurrenceRule', 'reminderMinutesBefore', 'topicId', 'parentId', 'tagIds'] as const;
export type MetaDraft = Pick<TaskDraft, typeof metaFields[number]>;
export type MetaEditing = { base: MetaDraft; draft: MetaDraft; conflicts: string[] };

export function isMetaDirty(editing: MetaEditing | null): boolean {
  return Boolean(editing && (metaFields.some((field) => !sameField(editing.base[field], editing.draft[field])) || editing.conflicts.length > 0));
}

/** 成功保存后用响应替换 base，并清掉已解决的冲突。草稿里另有改动时仍然算脏。 */
export function editingAfterSuccessfulSave(editing: MetaEditing | null, incoming: MetaDraft): MetaEditing | null {
  if (!editing) return editing;
  return { ...editing, base: incoming, conflicts: [] };
}

export type QueuedLeave = 'wait' | 'confirm' | 'leave';

/**
 * 离开动作被推迟到保存结束之后时怎么处理。
 * `dirty` 必须是这次保存结果已经写入编辑状态之后的元数据脏状态，不能用渲染前的值。
 * 正文是否允许离开不在这里判断：和没有保存进行中时一样，交给 prepareLeave。
 * 保存失败单独算未保存：失败后的回滚会把草稿收回 base，若只看回滚后的 dirty 会把失败当成可以离开。
 */
export function decideQueuedLeave(input: {
  hasPending: boolean;
  savingCount: number;
  dirty: boolean;
  saveFailed: boolean;
}): QueuedLeave {
  if (!input.hasPending || input.savingCount > 0) return 'wait';
  if (input.saveFailed || input.dirty) return 'confirm';
  return 'leave';
}
