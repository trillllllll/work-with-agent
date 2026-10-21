import { DomainError } from '../domain/task.js';
import { z } from 'zod';
import { TaskService } from './workspace-task.js';
import { TopicService, TagService } from './workspace-topic.js';
import { parseInput, tagColors, taskFields as taskFieldObject, topicCreateSchema } from './workspace-input.js';
import { ChangeGroup, conflict, isGroup, notFound, now, prisma, restoreGroup, mutationTransaction, recordChange, type Db, type MutationContext, type GroupSnapshot } from './workspace-store.js';
import { hasUndoHandler, externalUndo } from './undo-registry.js';
import { ownerActor } from './security.js';

export { TaskService, TopicService, TagService };
export type { MutationContext };
export type ToolCall = { name: string; arguments: Record<string, unknown>; id?: string; invalidArguments?: boolean };
type StoredChange = { entityType: string; entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null };

export class WorkspaceMutation {
  constructor(private readonly topics = new TopicService(), private readonly tasks = new TaskService(), private readonly tags = new TagService()) {}

  async execute(call: ToolCall, context: MutationContext): Promise<unknown> {
    const args = call.arguments;
    switch (call.name) {
      case 'create_task': return this.tasks.create(args, context);
      case 'update_task': return this.tasks.update(String(args.taskId), args, context);
      case 'delete_task': return this.tasks.remove(String(args.taskId), context);
      case 'restore_task': return this.tasks.restore(String(args.taskId), context);
      case 'permanent_delete_task': return this.tasks.permanentDelete(String(args.taskId), context);
      case 'reorder_tasks': return this.tasks.reorder(args, context);
      case 'create_topic': return this.topics.create(args, context);
      case 'update_topic': return this.topics.update(String(args.topicId), args, context);
      case 'delete_topic': return this.topics.remove(String(args.topicId), context);
      case 'archive_topic': return this.topics.archive(String(args.topicId), context);
      case 'restore_topic': return this.topics.restore(String(args.topicId), context);
      case 'move_topic_tasks_to_inbox': return this.topics.moveTasksToInbox(String(args.topicId), context);
      case 'propose_topic_summary': return this.topics.generateSummary(String(args.topicId), String(args.summary), context);
      case 'create_tag': return this.tags.create(args, context);
      case 'update_tag': return this.tags.update(String(args.tagId), args, context);
      case 'delete_tag': return this.tags.remove(String(args.tagId), context);
      default: throw new DomainError('UNKNOWN_TOOL', `不支持的写入 Tool: ${call.name}`, 400);
    }
  }

  async restore(record: StoredChange, context: MutationContext, db: Db = prisma) {
    const run = async (tx: Db) => {
      const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
      const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
      if (isGroup(before) && isGroup(after)) return restoreGroup(tx, before, after, context);
      const legacy = await legacySnapshots(tx, record, before, after, context);
      return restoreGroup(tx, legacy.before, legacy.after, context);
    };
    return db === prisma ? prisma.$transaction(run) : run(db);
  }
}

export class ChangeService {
  constructor(private readonly mutations = new WorkspaceMutation()) {}

  async list(entityType?: string, entityId?: string) {
    const records = await prisma.changeRecord.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return records.map((record) => ({ ...record, reversible: reversibleChange(record.entityType, record.operation) }));
  }

  async undo(id: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const record = await tx.changeRecord.findUnique({ where: { id } });
      if (!record) throw notFound('变更记录不存在');
      if (!reversibleChange(record.entityType, record.operation)) throw new DomainError('CHANGE_NOT_REVERSIBLE', record.entityType === 'execution' ? '受控执行记录不可撤销' : '该变更不可撤销', 400);
      if (record.undoneAt) throw new DomainError('CHANGE_ALREADY_UNDONE', '该变更已经撤销', 400);
      const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
      const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
      if (hasUndoHandler(record.entityType) || before?.version === 3) {
        if (before?.version === 3) {
          const taskIds = new Set<string>(before.changes.filter((item: { entityType: string }) => item.entityType === 'task').map((item: { entityId: string }) => item.entityId));
          const owned = { ...context, requestId: undefined, undoOwnership: { taskIdsRestoredByGroup: taskIds } };
          for (let index = 0; index < before.changes.length; index += 1) await assertUndoCurrent(tx, before.changes[index], after.changes[index]);
          for (let index = before.changes.length - 1; index >= 0; index -= 1) {
            const item = before.changes[index];
            const part = { ...item, beforeSnapshot: item.snapshot, afterSnapshot: after.changes[index].snapshot };
            if (hasUndoHandler(item.entityType)) await externalUndo(tx, owned.actor ?? ownerActor, part, owned);
            else await this.mutations.restore(part, owned, tx);
          }
        } else await externalUndo(tx, context.actor ?? ownerActor, record, { ...context, requestId: undefined });
        await tx.changeRecord.update({ where: { id }, data: { undoneAt: now() } });
        const reversal = await recordChange(tx, record.entityType, record.entityId, `undo:${record.operation}`, after, before, context, id);
        return { success: true, meta: { changeId: reversal.id, affectedTaskIds: [] as string[] } };
      }
      const undo = await this.mutations.restore(record, context, tx);
      await tx.changeRecord.update({ where: { id }, data: { undoneAt: now() } });
      const meta = await undo.record(record.entityType, record.entityId, `undo:${record.operation}`, id);
      return { success: true, meta };
    });
  }
}

async function assertUndoCurrent(tx: Db, beforeItem: { entityType: string; entityId: string; operation: string; snapshot: string | null }, afterItem: { snapshot: string | null }) {
  const beforeSnap = beforeItem.snapshot ? JSON.parse(beforeItem.snapshot) : null;
  const afterSnap = afterItem.snapshot ? JSON.parse(afterItem.snapshot) : null;
  if (beforeItem.entityType === 'task') {
    const current = await tx.task.findUnique({ where: { id: beforeItem.entityId } });
    if (!afterSnap || !current || current.revision !== afterSnap.revision) throw conflict('对象已发生后续变更，无法撤销');
    if (afterSnap.updatedAt !== undefined && current.updatedAt !== afterSnap.updatedAt) throw conflict('对象已发生后续变更，无法撤销');
    return;
  }
  if (beforeItem.entityType === 'material') {
    const current = await tx.material.findUnique({ where: { id: beforeItem.entityId } });
    if (!afterSnap || !current || current.revision !== afterSnap.revision) throw conflict('对象已发生后续变更，无法撤销');
    if (beforeSnap?.links && beforeSnap.revision === afterSnap.revision && current.organizationRevision !== afterSnap.organizationRevision) throw conflict('对象已发生后续变更，无法撤销');
    return;
  }
  if (beforeItem.entityType === 'libraryFolder' || beforeItem.entityType === 'libraryTag') {
    const current = beforeItem.entityType === 'libraryFolder'
      ? await tx.libraryFolder.findUnique({ where: { id: beforeItem.entityId } })
      : await tx.libraryTag.findUnique({ where: { id: beforeItem.entityId } });
    if (beforeItem.operation === 'delete' || afterSnap?.deleted) {
      if (current) throw conflict('对象已发生后续变更，无法撤销');
      return;
    }
    if (!afterSnap || !current || current.revision !== afterSnap.revision) throw conflict('对象已发生后续变更，无法撤销');
  }
}

function reversibleChange(entityType: string, operation: string) {
  if (operation.startsWith('undo:')) return false;
  if (entityType === 'workspace' && operation === 'batch') return true;
  if (entityType === 'proposal' && operation === 'batch') return true;
  if (hasUndoHandler(entityType)) return true;
  if (entityType === 'task') return ['create', 'update', 'delete', 'restore', 'reorder'].includes(operation);
  if (entityType === 'topic') return ['create', 'update', 'delete', 'archive', 'archive_preserve', 'restore', 'move_tasks_to_inbox', 'confirm_summary', 'discard_summary'].includes(operation);
  if (entityType === 'tag') return ['create', 'update', 'delete'].includes(operation);
  return false;
}

const taskFields = ['id', 'topicId', 'title', 'description', 'status', 'priority', 'dueDate', 'estimatedMinutes', 'scheduledStart', 'scheduledEnd', 'resultSummary', 'deletedAt', 'createdAt', 'updatedAt', 'parentId', 'sortOrder', 'revision', 'deleteBatchId', 'tagIds'];
const topicFields = ['id', 'name', 'description', 'color', 'isExploration', 'goal', 'draftSummary', 'finalSummary', 'summaryStatus', 'summaryUpdatedAt', 'archivedAt', 'createdAt', 'updatedAt', 'revision'];
function pickFields(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

const legacyTaskSchema = taskFieldObject.extend({
  id: z.string().min(1),
  topicId: z.string().min(1).nullable().default(null),
  parentId: z.string().min(1).nullable().default(null),
  description: z.string().default(''),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).default('todo'),
  priority: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  dueDate: taskFieldObject.shape.dueDate.default(null),
  estimatedMinutes: taskFieldObject.shape.estimatedMinutes.default(null),
  scheduledStart: taskFieldObject.shape.scheduledStart.default(null),
  scheduledEnd: taskFieldObject.shape.scheduledEnd.default(null),
  resultSummary: z.string().default(''),
  deletedAt: z.string().nullable().default(null),
  deleteBatchId: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
  revision: z.number().int().min(1).default(1),
  tagIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
  completedAt: z.string().nullable().default(null),
  completedAtEstimated: z.boolean().default(false),
});
const legacyTopicSchema = topicCreateSchema.extend({
  id: z.string().min(1),
  description: z.string().default(''),
  color: z.enum(tagColors).default('slate'),
  isExploration: z.boolean().default(false),
  goal: z.string().default(''),
  draftSummary: z.string().default(''),
  finalSummary: z.string().default(''),
  summaryStatus: z.string().default('empty'),
  summaryUpdatedAt: z.string().nullable().default(null),
  archivedAt: z.string().nullable().default(null),
  revision: z.number().int().min(1).default(1),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
});

/** Lift old snapshots into the group format without interpreting absent new fields as clears. */
async function legacySnapshots(tx: Db, record: StoredChange, before: any, after: any, context: MutationContext): Promise<{ before: GroupSnapshot; after: GroupSnapshot }> {
  const kind = record.entityType === 'task' ? 'tasks' : record.entityType === 'topic' ? 'topics' : null;
  if (!kind) throw new DomainError('INVALID_CHANGE', '不支持的历史变更类型', 400);
  const group = new ChangeGroup(tx, context);
  await group.capture(kind, record.entityId);
  const current = kind === 'tasks' ? await tx.task.findUnique({ where: { id: record.entityId } }) : await tx.topic.findUnique({ where: { id: record.entityId } });
  if (after && !current) throw conflict('对象已发生后续变更，无法撤销');
  if (after && current && 'revision' in after && current.revision !== after.revision) throw conflict('对象已发生后续变更，无法撤销');
  if (after && current && after.updatedAt !== undefined && current.updatedAt !== after.updatedAt) throw conflict('对象已发生后续变更，无法撤销');
  if (!after && current) throw conflict('对象已发生后续变更，无法撤销');

  if (record.entityType === 'topic' && record.operation === 'archive') {
    if ((current as any)?.archivedAt !== after?.archivedAt) throw conflict('清单已发生后续变更，无法撤销');
    const beforeTasks: any[] = Array.isArray(before?.tasks) ? before.tasks : [];
    const afterTasks: any[] = Array.isArray(after?.tasks) ? after.tasks : [];
    for (const oldTask of beforeTasks) {
      const expected = afterTasks.find((task) => task.id === oldTask.id);
      const task = await tx.task.findUnique({ where: { id: oldTask.id } });
      if (!task || !expected || task.topicId !== null || task.updatedAt !== expected.updatedAt) throw conflict('清单中的任务已发生后续变更，无法撤销');
      await group.capture('tasks', task.id);
    }
    const state = await group.after();
    const desired = structuredClone(state);
    desired.entities.topics[record.entityId] = { ...desired.entities.topics[record.entityId]!, ...pickFields(before, topicFields) };
    for (const task of beforeTasks) desired.entities.tasks[task.id] = { ...desired.entities.tasks[task.id]!, ...pickFields(task, taskFields) };
    return { before: desired, after: state };
  }

  if (record.operation === 'create') {
    if (kind === 'topics' && await tx.task.count({ where: { topicId: record.entityId } })) throw conflict('清单已有后续任务，无法撤销');
    if (kind === 'tasks' && await tx.task.count({ where: { parentId: record.entityId } })) throw conflict('任务已有子任务，无法撤销');
  }
  const state = await group.after();
  const desired = structuredClone(state);
  if (before === null) desired.entities[kind][record.entityId] = null;
  else {
    const existing = desired.entities[kind][record.entityId];
    if (!existing) {
      if (record.operation !== 'delete' || before.id !== record.entityId) throw conflict('历史对象已不存在，无法安全恢复');
      // Earlier releases used hard deletion. Restore a valid old snapshot with the
      // same ID, supplying only fields that did not exist in that schema version.
      if (kind === 'tasks') desired.entities.tasks[record.entityId] = parseInput(legacyTaskSchema, before);
      else desired.entities.topics[record.entityId] = parseInput(legacyTopicSchema, before);
    } else (desired.entities[kind] as Record<string, unknown>)[record.entityId] = { ...existing, ...pickFields(before, kind === 'tasks' ? taskFields : topicFields) };
  }
  return { before: desired, after: state };
}
