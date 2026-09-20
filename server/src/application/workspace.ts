import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { DomainError, Task as TaskDomain, allowedTaskTransitions, type TaskStatusValue } from '../domain/task.js';
import { Topic as TopicDomain } from '../domain/topic.js';
import { prisma } from '../infrastructure/prisma.js';

export type MutationContext = { source: 'user' | 'agent'; conversationId?: string; approvalId?: string; requestId?: string };
export type ToolCall = { name: string; arguments: Record<string, unknown>; id?: string };
type Db = Prisma.TransactionClient | typeof prisma;
const now = () => new Date().toISOString();
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

export class TopicService {
  async list() { return prisma.topic.findMany({ where: { archivedAt: null }, orderBy: { updatedAt: 'desc' } }); }
  async get(topicId: string) { const topic = await prisma.topic.findFirst({ where: { id: topicId, archivedAt: null }, include: { tasks: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } } } }); return topic ? { ...topic, tasks: topic.tasks.map(taskDto) } : null; }
  async create(input: { name: string; description?: string; isExploration?: boolean; goal?: string }, context: MutationContext | string = { source: 'user' }) { const ctx = normalizeContext(context); return prisma.$transaction(async (tx) => { const timestamp = now(); const result = await tx.topic.create({ data: { name: input.name, description: input.description ?? '', goal: input.goal ?? '', isExploration: input.isExploration ?? false, createdAt: timestamp, updatedAt: timestamp } }); await recordChange(tx, 'topic', result.id, 'create', null, result, ctx); return result; }); }
  async update(topicId: string, input: Partial<{ name: string; description: string; isExploration: boolean; goal: string; draftSummary: string }>, context: MutationContext | string = { source: 'user' }) { const ctx = normalizeContext(context); return prisma.$transaction(async (tx) => { const before = await tx.topic.findFirst({ where: { id: topicId, archivedAt: null } }); if (!before) throw notFound('主题不存在'); const data: any = { ...input, updatedAt: now() }; if (input.draftSummary !== undefined) { const topic = TopicDomain.restore(before); if (input.draftSummary) topic.proposeSummary(input.draftSummary); else topic.discardSummary(); Object.assign(data, topic.summaryState(), { summaryUpdatedAt: now() }); } const result = await tx.topic.update({ where: { id: topicId }, data }); await recordChange(tx, 'topic', topicId, 'update', before, result, ctx); return result; }); }
  async remove(topicId: string, context: MutationContext | string = { source: 'user' }) { const ctx = normalizeContext(context); return prisma.$transaction(async (tx) => { const topic = await tx.topic.findFirst({ where: { id: topicId, archivedAt: null }, include: { tasks: true } }); if (!topic) throw notFound('主题不存在'); const timestamp = now(); await tx.task.updateMany({ where: { topicId }, data: { topicId: null, updatedAt: timestamp } }); if (topic.tasks.length) await tx.taskTopicAssignment.createMany({ data: topic.tasks.map((task) => assignmentData(task.id, topicId, null, 'topic_archived', ctx, timestamp)) }); const result = await tx.topic.update({ where: { id: topicId }, data: { archivedAt: timestamp, updatedAt: timestamp } }); const afterTasks = topic.tasks.map((task) => ({ ...task, topicId: null, updatedAt: timestamp })); await recordChange(tx, 'topic', topicId, 'archive', topic, { ...result, tasks: afterTasks }, ctx); return result; }); }
  async generateSummary(topicId: string, summary: string, context: MutationContext = { source: 'agent' }) { return this.update(topicId, { draftSummary: summary }, context); }
  async confirmSummary(topicId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.topic.findFirst({ where: { id: topicId, archivedAt: null } }); if (!before) throw notFound('主题不存在'); const topic = TopicDomain.restore(before); topic.confirmSummary(); const result = await tx.topic.update({ where: { id: topicId }, data: { ...topic.summaryState(), summaryUpdatedAt: now(), updatedAt: now() } }); await recordChange(tx, 'topic', topicId, 'confirm_summary', before, result, context); return result; }); }
  async discardSummary(topicId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.topic.findFirst({ where: { id: topicId, archivedAt: null } }); if (!before) throw notFound('主题不存在'); const topic = TopicDomain.restore(before); topic.discardSummary(); const result = await tx.topic.update({ where: { id: topicId }, data: { ...topic.summaryState(), summaryUpdatedAt: now(), updatedAt: now() } }); await recordChange(tx, 'topic', topicId, 'discard_summary', before, result, context); return result; }); }
}

export class TaskService {
  async list(topicId?: string, options: { includeDeleted?: boolean; inbox?: boolean } = {}) { return (await prisma.task.findMany({ where: { ...(topicId ? { topicId } : {}), ...(options.inbox ? { topicId: null } : {}), ...(options.includeDeleted ? {} : { deletedAt: null }) }, orderBy: { updatedAt: 'desc' } })).map(taskDto); }
  async listDeleted() { return (await prisma.task.findMany({ where: { deletedAt: { not: null } }, include: { topic: { select: { id: true, name: true } } }, orderBy: { deletedAt: 'desc' } })).map(taskDto); }
  async get(taskId: string, options: { includeDeleted?: boolean } = {}) { const task = await prisma.task.findFirst({ where: { id: taskId, ...(options.includeDeleted ? {} : { deletedAt: null }) } }); return task ? taskDto(task) : null; }
  async create(input: { topicId?: string | null; title: string; description?: string; status?: TaskStatus; priority?: TaskPriority; dueDate?: string | null; resultSummary?: string }, context: MutationContext | string = { source: 'user' }) { const ctx = normalizeContext(context); if (input.status && input.status !== TaskStatus.todo) throw new DomainError('INVALID_INITIAL_TASK_STATUS', '新任务必须从待办状态开始', 400); return prisma.$transaction(async (tx) => { if (input.topicId && !(await tx.topic.findFirst({ where: { id: input.topicId, archivedAt: null } }))) throw notFound('主题不存在'); const timestamp = now(); const result = await tx.task.create({ data: { topicId: input.topicId ?? null, title: input.title, description: input.description ?? '', status: TaskStatus.todo, priority: input.priority ?? TaskPriority.none, dueDate: input.dueDate ?? null, resultSummary: input.resultSummary ?? '', createdAt: timestamp, updatedAt: timestamp } }); if (result.topicId) await tx.taskTopicAssignment.create({ data: assignmentData(result.id, null, result.topicId, 'created', ctx, timestamp) }); await recordChange(tx, 'task', result.id, 'create', null, result, ctx); return taskDto(result); }); }
  async update(taskId: string, input: Partial<{ title: string; description: string; status: TaskStatus; priority: TaskPriority; dueDate: string | null; resultSummary: string; topicId: string | null }>, context: MutationContext | string = { source: 'user' }) { const ctx = normalizeContext(context); return prisma.$transaction(async (tx) => { if (input.topicId && !(await tx.topic.findFirst({ where: { id: input.topicId, archivedAt: null } }))) throw notFound('主题不存在'); const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); const task = TaskDomain.restore({ id: before.id, status: before.status as TaskStatusValue, topicId: before.topicId, deletedAt: before.deletedAt }); if (input.status) task.transitionTo(input.status as TaskStatusValue); else if (before.deletedAt) throw new DomainError('TASK_NOT_EDITABLE', '回收站中的任务不能直接修改'); const timestamp = now(); const result = await tx.task.update({ where: { id: taskId }, data: { ...input, updatedAt: timestamp } }); if ('topicId' in input && input.topicId !== before.topicId) await tx.taskTopicAssignment.create({ data: assignmentData(taskId, before.topicId, input.topicId ?? null, input.topicId ? 'assigned' : 'unassigned', ctx, timestamp) }); await recordChange(tx, 'task', taskId, 'update', before, result, ctx); return taskDto(result); }); }
  async remove(taskId: string, context: MutationContext | string = { source: 'user' }) { return this.softDelete(taskId, normalizeContext(context)); }
  async softDelete(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before) throw notFound('任务不存在'); if (before.deletedAt) throw Object.assign(new Error('任务已在回收站'), { status: 409 }); const result = await tx.task.update({ where: { id: taskId }, data: { deletedAt: now(), updatedAt: now() } }); await recordChange(tx, 'task', taskId, 'delete', before, result, context); return result; }); }
  async restore(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const task = await tx.task.findUnique({ where: { id: taskId }, include: { topic: true } }); if (!task || !task.deletedAt) throw Object.assign(new Error('任务不在回收站'), { status: 409 }); if (task.topicId && !task.topic) throw Object.assign(new Error('原主题不存在，无法恢复任务'), { status: 409 }); const result = await tx.task.update({ where: { id: taskId }, data: { deletedAt: null, updatedAt: now() } }); await recordChange(tx, 'task', taskId, 'restore', task, result, context); return result; }); }
  async permanentDelete(taskId: string, context: MutationContext = { source: 'user' }) { return prisma.$transaction(async (tx) => { const before = await tx.task.findUnique({ where: { id: taskId } }); if (!before || !before.deletedAt) throw Object.assign(new Error('任务不在回收站'), { status: 409 }); await tx.task.delete({ where: { id: taskId } }); await recordChange(tx, 'task', taskId, 'permanent_delete', before, null, context); return before; }); }
  async topicHistory(taskId: string) { if (!(await prisma.task.findUnique({ where: { id: taskId } }))) throw notFound('任务不存在'); return prisma.taskTopicAssignment.findMany({ where: { taskId }, include: { fromTopic: { select: { id: true, name: true } }, toTopic: { select: { id: true, name: true } } }, orderBy: { changedAt: 'asc' } }); }
}

export class WorkspaceMutation {
  constructor(private readonly topics = new TopicService(), private readonly tasks = new TaskService()) {}
  async execute(call: ToolCall, context: MutationContext): Promise<unknown> {
    switch (call.name) {
      case 'create_task': return this.tasks.create({ topicId: typeof call.arguments.topicId === 'string' ? call.arguments.topicId : null, title: String(call.arguments.title), description: call.arguments.description as string | undefined, status: call.arguments.status as TaskStatus | undefined, priority: call.arguments.priority as TaskPriority | undefined, dueDate: call.arguments.dueDate as string | null | undefined, resultSummary: call.arguments.resultSummary as string | undefined }, context);
      case 'update_task': return this.tasks.update(String(call.arguments.taskId), { topicId: call.arguments.topicId as string | undefined, title: call.arguments.title as string | undefined, description: call.arguments.description as string | undefined, status: call.arguments.status as TaskStatus | undefined, priority: call.arguments.priority as TaskPriority | undefined, dueDate: call.arguments.dueDate as string | null | undefined, resultSummary: call.arguments.resultSummary as string | undefined }, context);
      case 'delete_task': return this.tasks.remove(String(call.arguments.taskId), context);
      case 'restore_task': return this.tasks.restore(String(call.arguments.taskId), context);
      case 'permanent_delete_task': return this.tasks.permanentDelete(String(call.arguments.taskId), context);
      case 'create_topic': return this.topics.create({ name: String(call.arguments.name), description: call.arguments.description as string | undefined, isExploration: call.arguments.isExploration as boolean | undefined }, context);
      case 'update_topic': return this.topics.update(String(call.arguments.topicId), { name: call.arguments.name as string | undefined, description: call.arguments.description as string | undefined, isExploration: call.arguments.isExploration as boolean | undefined }, context);
      case 'delete_topic': return this.topics.remove(String(call.arguments.topicId), context);
      case 'propose_topic_summary': return this.topics.generateSummary(String(call.arguments.topicId), String(call.arguments.summary), context);
      default: throw badRequest(`不支持的写入 Tool: ${call.name}`);
    }
  }
  async restore(record: { entityType: string; entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }, context: MutationContext, db: Db = prisma) {
    const run = async (tx: Db) => {
      const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
      const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
      if (record.entityType === 'topic' && record.operation === 'archive') {
        const currentTopic = await tx.topic.findUnique({ where: { id: record.entityId } });
        if (!currentTopic || currentTopic.updatedAt !== after?.updatedAt || currentTopic.archivedAt !== after?.archivedAt) throw new DomainError('UNDO_CONFLICT', '主题已发生后续变更，无法撤销');
        const beforeTasks = Array.isArray(before?.tasks) ? before.tasks : [];
        const afterTasks = Array.isArray(after?.tasks) ? after.tasks : [];
        const currentTasks = await tx.task.findMany({ where: { id: { in: beforeTasks.map((task: any) => task.id) } } });
        const afterById = new Map(afterTasks.map((task: any) => [task.id, task]));
        if (currentTasks.length !== beforeTasks.length || currentTasks.some((task) => task.topicId !== null || task.updatedAt !== (afterById.get(task.id) as any)?.updatedAt)) throw new DomainError('UNDO_CONFLICT', '主题中的任务已发生后续变更，无法撤销');
        await tx.topic.update({ where: { id: record.entityId }, data: sanitizeTopic(before) });
        for (const task of beforeTasks) await tx.task.update({ where: { id: task.id }, data: sanitizeTask(task) });
        if (beforeTasks.length) await tx.taskTopicAssignment.createMany({ data: beforeTasks.map((task: any) => assignmentData(task.id, null, record.entityId, 'undo', context)) });
        return { before, after };
      }
      const current = record.entityType === 'task' ? await tx.task.findUnique({ where: { id: record.entityId } }) : await tx.topic.findUnique({ where: { id: record.entityId } });
      if (after && (!current || current.updatedAt !== after.updatedAt)) throw new DomainError('UNDO_CONFLICT', '实体已发生后续变更，无法撤销');
      if (record.entityType === 'task') {
        if (record.operation === 'create') await tx.task.delete({ where: { id: record.entityId } });
        else if (record.operation === 'delete') current ? await tx.task.update({ where: { id: record.entityId }, data: sanitizeTask(before) }) : await tx.task.create({ data: sanitizeTask(before) });
        else { await tx.task.update({ where: { id: record.entityId }, data: sanitizeTask(before) }); if (before?.topicId !== after?.topicId) await tx.taskTopicAssignment.create({ data: assignmentData(record.entityId, after?.topicId ?? null, before?.topicId ?? null, 'undo', context) }); }
      } else if (record.entityType === 'topic') {
        if (record.operation === 'create') await tx.topic.delete({ where: { id: record.entityId } });
        else if (record.operation === 'delete') await tx.topic.create({ data: sanitizeTopic(before) });
        else await tx.topic.update({ where: { id: record.entityId }, data: sanitizeTopic(before) });
      } else throw badRequest('不支持的变更实体类型');
      return { before, after };
    };
    return db === prisma ? prisma.$transaction(run) : run(db);
  }
}

export class ChangeService {
  constructor(private readonly mutations = new WorkspaceMutation()) {}
  async list(entityType?: string, entityId?: string) { return (await prisma.changeRecord.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: 'desc' } })).map((record) => ({ ...record, reversible: reversibleChange(record.entityType, record.operation) })); }
  async undo(id: string, context: MutationContext = { source: 'user' }) { const record = await prisma.changeRecord.findUnique({ where: { id } }); if (!record) throw notFound('变更记录不存在'); if (!reversibleChange(record.entityType, record.operation)) throw new DomainError('CHANGE_NOT_REVERSIBLE', record.entityType === 'execution' ? '受控执行记录不可撤销' : '该变更不可撤销', 400); if (record.undoneAt) throw badRequest('该变更已经撤销'); return prisma.$transaction(async (tx) => { await this.mutations.restore(record, context, tx); await tx.changeRecord.update({ where: { id }, data: { undoneAt: now() } }); await recordChange(tx, record.entityType, record.entityId, `undo:${record.operation}`, record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null, record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null, context, id); return { success: true }; }); }
}

function normalizeContext(context: MutationContext | string): MutationContext { return typeof context === 'string' ? { source: context as MutationContext['source'] } : context; }
function taskDto<T extends { status: TaskStatus; deletedAt: string | null }>(task: T) { return { ...task, allowedTransitions: task.deletedAt ? [] : allowedTaskTransitions(task.status as TaskStatusValue) }; }
function assignmentData(taskId: string, fromTopicId: string | null, toTopicId: string | null, reason: string, context: MutationContext, changedAt = now()) { return { taskId, fromTopicId, toTopicId, reason, source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, changedAt }; }
function sanitizeTask(value: any) { const { topic, ...data } = value ?? {}; return { ...data, status: data.status as TaskStatus }; }
function sanitizeTopic(value: any) { const { tasks, ...data } = value ?? {}; return data; }
function reversibleChange(entityType: string, operation: string) { if (operation.startsWith('undo:')) return false; if (entityType === 'task') return ['create', 'update', 'delete', 'restore'].includes(operation); if (entityType === 'topic') return ['create', 'update', 'delete', 'archive', 'confirm_summary', 'discard_summary'].includes(operation); return false; }
async function recordChange(db: Db, entityType: string, entityId: string, operation: string, before: unknown, after: unknown, context: MutationContext, reversalOf?: string) { return db.changeRecord.create({ data: { entityType, entityId, operation, beforeSnapshot: before ? JSON.stringify(before) : null, afterSnapshot: after ? JSON.stringify(after) : null, source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, requestId: context.requestId, reversalOf, createdAt: now() } }); }
