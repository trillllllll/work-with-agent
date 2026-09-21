import { Prisma, type Task, type Topic, type Tag, type ChangeRecord } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError, allowedTaskTransitions } from '../domain/task.js';
import type { Actor } from './security.js';

export type MutationContext = { source: 'user' | 'agent'; conversationId?: string; approvalId?: string; requestId?: string; actor?: Actor; proposalId?: string; db?: Db; entityId?: string; preview?: boolean; auditRecords?: ChangeRecord[] };
export type Db = Prisma.TransactionClient;
export const now = () => new Date().toISOString();
function updatedAfter(previous?: string) {
  const prior = previous ? Date.parse(previous) : NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
}
export const notFound = (message: string) => new DomainError('NOT_FOUND', message, 404);
export const conflict = (message: string) => new DomainError('UNDO_CONFLICT', message);
export const normalizeContext = (context: MutationContext | string): MutationContext => typeof context === 'string' ? { source: context as MutationContext['source'] } : context;
export function mutationTransaction<T>(context: MutationContext | string, run: (tx: Db) => Promise<T>) {
  const current = normalizeContext(context);
  return current.db ? run(current.db) : prisma.$transaction(run, { timeout: 30_000 });
}
export const taskInclude = { tags: { include: { tag: true } }, topic: { select: { id: true, name: true, archivedAt: true } } } satisfies Prisma.TaskInclude;
type IncludedTask = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
export function taskDto(task: IncludedTask) {
  const tags = task.tags.map(({ tag }) => tag).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { ...task, tags, tagIds: tags.map((tag) => tag.id), allowedTransitions: task.deletedAt || task.topic?.archivedAt ? [] : allowedTaskTransitions(task.status) };
}
export async function readTask(tx: Db, id: string) {
  const value = await tx.task.findUnique({ where: { id }, include: taskInclude });
  if (!value) throw notFound('任务不存在');
  return value;
}
export async function activeTopic(tx: Db, id: string | null) {
  if (!id) return null;
  const topic = await tx.topic.findUnique({ where: { id } });
  if (!topic) throw notFound('清单不存在');
  if (topic.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档清单不能修改');
  return topic;
}
export async function editableTask(tx: Db, id: string) {
  const task = await readTask(tx, id);
  if (task.deletedAt) throw new DomainError('TASK_NOT_EDITABLE', '回收站中的任务不能直接修改');
  await activeTopic(tx, task.topicId);
  return task;
}
export async function nextOrder(tx: Db, topicId: string | null, parentId: string | null) {
  const { _max } = await tx.task.aggregate({ where: { topicId, parentId, deletedAt: null }, _max: { sortOrder: true } });
  return (_max.sortOrder ?? -1) + 1;
}
export async function validateTags(tx: Db, tagIds: string[]) {
  if (await tx.tag.count({ where: { id: { in: tagIds } } }) !== tagIds.length) throw notFound('部分标签不存在');
}
export async function setTags(tx: Db, taskId: string, tagIds: string[]) {
  await tx.taskTag.deleteMany({ where: { taskId } });
  if (tagIds.length) await tx.taskTag.createMany({ data: tagIds.map((tagId) => ({ taskId, tagId })) });
}
export function assignmentData(taskId: string, fromTopicId: string | null, toTopicId: string | null, reason: string, context: MutationContext, changedAt = now()) {
  return { taskId, fromTopicId, toTopicId, reason, source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, changedAt };
}

type TaskSnapshot = Task & { tagIds: string[] };
type EntityMaps = { tasks: Record<string, TaskSnapshot | null>; topics: Record<string, Topic | null>; tags: Record<string, Tag | null> };
export type Scope = { kind: 'order'; topicId: string | null; parentId: string | null } | { kind: 'children'; id: string } | { kind: 'topic'; id: string } | { kind: 'tag'; id: string };
type ScopeSnapshot = { scope: Scope; members: string[] };
export type GroupSnapshot = { version: 2; entities: EntityMaps; scopes: ScopeSnapshot[] };
export function isGroup(value: any): value is GroupSnapshot { return value?.version === 2 && Boolean(value.entities && value.scopes); }

async function readEntity(tx: Db, kind: keyof EntityMaps, id: string): Promise<any> {
  if (kind === 'topics') return tx.topic.findUnique({ where: { id } });
  if (kind === 'tags') return tx.tag.findUnique({ where: { id } });
  const task = await tx.task.findUnique({ where: { id }, include: { tags: true } });
  if (!task) return null;
  const { tags, ...data } = task;
  return { ...data, tagIds: tags.map((tag) => tag.tagId).sort() };
}
async function scopeMembers(tx: Db, scope: Scope) {
  if (scope.kind === 'tag') return (await tx.taskTag.findMany({ where: { tagId: scope.id } })).map((row) => row.taskId).sort();
  const where: Prisma.TaskWhereInput = scope.kind === 'children' ? { parentId: scope.id } : scope.kind === 'topic' ? { topicId: scope.id } : { topicId: scope.topicId, parentId: scope.parentId, deletedAt: null };
  const rows = await tx.task.findMany({ where, select: { id: true, sortOrder: true } });
  return rows.map((row) => scope.kind === 'order' ? `${row.id}:${row.sortOrder}` : row.id).sort();
}

/** A transaction records one user intent, including every touched row and relation. */
export class ChangeGroup {
  private before: GroupSnapshot = { version: 2, entities: { tasks: {}, topics: {}, tags: {} }, scopes: [] };
  private timestamps = new Map<string, string>();
  constructor(readonly tx: Db, readonly context: MutationContext) {}
  async capture(kind: keyof EntityMaps, id: string) {
    if (!(id in this.before.entities[kind])) (this.before.entities[kind] as Record<string, unknown>)[id] = await readEntity(this.tx, kind, id);
  }
  async scope(scope: Scope) {
    if (!this.before.scopes.some((item) => JSON.stringify(item.scope) === JSON.stringify(scope))) this.before.scopes.push({ scope, members: await scopeMembers(this.tx, scope) });
  }
  async task(id: string, data: Prisma.TaskUncheckedUpdateInput = {}) {
    await this.capture('tasks', id);
    const updatedAt = updatedAfter(this.timestamps.get(`task:${id}`) ?? this.before.entities.tasks[id]?.updatedAt);
    const result = await this.tx.task.update({ where: { id }, data: { ...data, revision: { increment: 1 }, updatedAt } });
    this.timestamps.set(`task:${id}`, updatedAt);
    return result;
  }
  async topic(id: string, data: Prisma.TopicUncheckedUpdateInput = {}) {
    await this.capture('topics', id);
    const updatedAt = updatedAfter(this.timestamps.get(`topic:${id}`) ?? this.before.entities.topics[id]?.updatedAt);
    const result = await this.tx.topic.update({ where: { id }, data: { ...data, revision: { increment: 1 }, updatedAt } });
    this.timestamps.set(`topic:${id}`, updatedAt);
    return result;
  }
  async tag(id: string, data: Prisma.TagUncheckedUpdateInput = {}) {
    await this.capture('tags', id);
    const updatedAt = updatedAfter(this.timestamps.get(`tag:${id}`) ?? this.before.entities.tags[id]?.updatedAt);
    const result = await this.tx.tag.update({ where: { id }, data: { ...data, revision: { increment: 1 }, updatedAt } });
    this.timestamps.set(`tag:${id}`, updatedAt);
    return result;
  }
  async after(): Promise<GroupSnapshot> {
    const entities: EntityMaps = { tasks: {}, topics: {}, tags: {} };
    for (const kind of ['tasks', 'topics', 'tags'] as const) for (const id of Object.keys(this.before.entities[kind])) (entities[kind] as Record<string, unknown>)[id] = await readEntity(this.tx, kind, id);
    const scopes = [];
    for (const { scope } of this.before.scopes) scopes.push({ scope, members: await scopeMembers(this.tx, scope) });
    return { version: 2, entities, scopes };
  }
  async record(entityType: string, entityId: string, operation: string, reversalOf?: string) {
    const after = await this.after();
    const change = await recordChange(this.tx, entityType, entityId, operation, this.before, after, this.context, reversalOf);
    return { changeId: change.id, affectedTaskIds: Object.keys(after.entities.tasks) };
  }
}

export async function recordChange(tx: Db, entityType: string, entityId: string, operation: string, before: unknown, after: unknown, context: MutationContext, reversalOf?: string) {
  const record = await tx.changeRecord.create({ data: { entityType, entityId, operation, beforeSnapshot: before ? JSON.stringify(before) : null, afterSnapshot: after ? JSON.stringify(after) : null, source: context.source, conversationId: context.conversationId, approvalId: context.approvalId, requestId: context.requestId, actorId: context.actor?.id, connectionId: context.actor?.connectionId, proposalId: context.proposalId, reversalOf, createdAt: now() } });
  context.auditRecords?.push(record);
  return record;
}

export async function restoreGroup(tx: Db, before: GroupSnapshot, after: GroupSnapshot, context: MutationContext) {
  for (const kind of ['tasks', 'topics', 'tags'] as const) {
    for (const [id, expected] of Object.entries(after.entities[kind])) {
      const current = await readEntity(tx, kind, id);
      if (expected === null ? current !== null : !current || current.revision !== expected.revision || JSON.stringify(current) !== JSON.stringify(expected)) throw conflict('对象已发生后续变更，无法撤销');
    }
  }
  for (const { scope, members } of after.scopes) if (JSON.stringify(await scopeMembers(tx, scope)) !== JSON.stringify(members)) throw conflict('关联或排序范围已发生后续变更，无法撤销');

  // Check the projected state before writing. Unchanged rows can invalidate old references.
  const projectedTopics = new Map((await tx.topic.findMany()).map((row) => [row.id, row]));
  const projectedTasks = new Map((await tx.task.findMany()).map((row) => [row.id, row]));
  const projectedTags = new Set((await tx.tag.findMany()).map((row) => row.id));
  for (const [id, row] of Object.entries(before.entities.topics)) row ? projectedTopics.set(id, row) : projectedTopics.delete(id);
  for (const [id, row] of Object.entries(before.entities.tasks)) row ? projectedTasks.set(id, row) : projectedTasks.delete(id);
  for (const [id, row] of Object.entries(before.entities.tags)) row ? projectedTags.add(id) : projectedTags.delete(id);
  for (const row of projectedTasks.values()) {
    if (row.topicId && !projectedTopics.has(row.topicId)) throw conflict('原清单已不可用，无法撤销');
    if (row.parentId) {
      const parent = projectedTasks.get(row.parentId);
      if (!parent || parent.id === row.id || parent.parentId || parent.topicId !== row.topicId || (!row.deletedAt && (parent.deletedAt || (parent.status === 'done' && row.status !== 'done')))) throw conflict('撤销将产生非法父子关系');
    }
  }
  for (const [id, row] of Object.entries(before.entities.tasks)) {
    const expected = after.entities.tasks[id];
    // An explicit list operation can restore its own archived membership. A task-only
    // undo must not bypass a list that was archived after the original task edit.
    const archivedTarget = row?.topicId && projectedTopics.get(row.topicId)?.archivedAt && !before.entities.topics[row.topicId];
    const archivedSource = expected?.topicId && projectedTopics.get(expected.topicId)?.archivedAt && !before.entities.topics[expected.topicId];
    if (archivedTarget || archivedSource) throw conflict('原清单已归档，无法撤销');
    if (row?.tagIds.some((tagId) => !projectedTags.has(tagId))) throw conflict('原标签已不存在，无法撤销');
  }

  const undo = new ChangeGroup(tx, context);
  for (const kind of ['tasks', 'topics', 'tags'] as const) for (const id of Object.keys(before.entities[kind])) await undo.capture(kind, id);
  for (const { scope } of after.scopes) await undo.scope(scope);

  for (const kind of ['topics', 'tags'] as const) {
    for (const [id, row] of Object.entries(before.entities[kind])) {
      if (!row) continue;
      const current = after.entities[kind][id];
      const data = { ...row, revision: (current?.revision ?? row.revision) + 1, updatedAt: updatedAfter(current?.updatedAt ?? row.updatedAt) };
      if (kind === 'topics') await tx.topic.upsert({ where: { id }, create: data as Topic, update: data as Topic });
      else await tx.tag.upsert({ where: { id }, create: data as Tag, update: data as Tag });
    }
  }
  // Detach affected rows first so parent deletion/reparenting never violates foreign keys.
  const ids = Object.keys(before.entities.tasks);
  if (ids.length) await tx.task.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
  for (const [id, row] of Object.entries(before.entities.tasks)) {
    if (!row) { await tx.task.delete({ where: { id } }); continue; }
    const { tagIds, parentId, ...fields } = row;
    const current = after.entities.tasks[id];
    const data = { ...fields, parentId: null, revision: (current?.revision ?? row.revision) + 1, updatedAt: updatedAfter(current?.updatedAt ?? row.updatedAt) };
    await tx.task.upsert({ where: { id }, create: data, update: data });
    await setTags(tx, id, tagIds);
    if ((current?.topicId ?? null) !== row.topicId) await tx.taskTopicAssignment.create({ data: assignmentData(id, current?.topicId ?? null, row.topicId, 'undo', context) });
  }
  for (const [id, row] of Object.entries(before.entities.tasks)) if (row?.parentId) await tx.task.update({ where: { id }, data: { parentId: row.parentId } });
  for (const [id, row] of Object.entries(before.entities.tags)) if (!row) await tx.tag.delete({ where: { id } });
  for (const [id, row] of Object.entries(before.entities.topics)) if (!row) {
    if (await tx.taskTopicAssignment.count({ where: { OR: [{ fromTopicId: id }, { toTopicId: id }] } })) throw conflict('清单已有关联历史，无法撤销创建');
    await tx.topic.delete({ where: { id } });
  }
  return undo;
}

export { prisma };
