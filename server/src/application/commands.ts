import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Router } from 'express';
import { z } from 'zod';
import type { ChangeRecord } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { TaskService, TopicService, TagService, ChangeService } from './workspace.js';
import { taskCreateSchema, taskUpdateSchema, topicCreateSchema, topicUpdateSchema, tagSchema, reorderSchema, parseInput } from './workspace-input.js';
import { type Db, type MutationContext, type GroupSnapshot, isGroup, now } from './workspace-store.js';
import { type Actor, getActor, assertOwner, assertTopicAccess, actorFromConnection } from './security.js';
import { commandDescriptor } from './command-catalog.js';

export type Evidence = { type: 'material' | 'memory' | 'task'; id: string; revision: number; hash?: string };
export type Command = { kind: string; targetId?: string; expectedRevision?: number; input: Record<string, unknown>; clientRef?: string; entityId?: string; evidence?: Evidence[] };
export type Inspection = { preconditions: unknown; preview: unknown };
export type CommandHandler = {
  inspect(tx: Db, actor: Actor, command: Command): Promise<Inspection>;
  execute(tx: Db, actor: Actor, command: Command, context: MutationContext): Promise<unknown>;
  forceProposal?: boolean;
  ownerOnly?: boolean;
  autoAction?: string;
  inputSchema?: Record<string, unknown>;
  description?: string;
};
const handlers = new Map<string, CommandHandler>();
let evidenceValidator: ((tx: Db, actor: Actor, refs: Evidence[]) => Promise<unknown>) | undefined;
export function registerEvidenceValidator(validate: NonNullable<typeof evidenceValidator>) { evidenceValidator = validate; }
export function registerCommandHandler(kind: string, handler: CommandHandler) { handlers.set(kind, handler); }
export const workspaceEvents = new EventEmitter();
export function publishWorkspaceChange(data: unknown) { workspaceEvents.emit('change', data); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const alias: Record<string, string> = { create_task: 'task.create', update_task: 'task.update', delete_task: 'task.delete', restore_task: 'task.restore', permanent_delete_task: 'task.permanent_delete', reorder_tasks: 'task.reorder', create_topic: 'topic.create', update_topic: 'topic.update', delete_topic: 'topic.legacy_delete', archive_topic: 'topic.archive', restore_topic: 'topic.restore', move_topic_tasks_to_inbox: 'topic.move_tasks_to_inbox', create_tag: 'tag.create', update_tag: 'tag.update', delete_tag: 'tag.delete' };
const commandSchema = z.object({ kind: z.string().min(1), targetId: z.string().min(1).optional(), expectedRevision: z.number().int().min(1).optional(), input: z.record(z.unknown()).default({}), clientRef: z.string().min(1).optional(), evidence: z.array(z.object({ type: z.enum(['material', 'memory', 'task']), id: z.string().min(1), revision: z.number().int().min(1), hash: z.string().optional() })).max(120).optional() });
// Only proposal editing accepts a returned entityId, and normalization checks it
// against that proposal's persisted commands. New submissions cannot choose IDs.
const editedCommandSchema = commandSchema.extend({ entityId: z.string().min(1).optional() });
const submitSchema = z.object({ requestId: z.string().min(1).max(200), commands: z.array(commandSchema).min(1).max(50), previewToken: z.string().optional() });
type PreviewTicket = { actorId: string; scopeRevision: number; requestHash: string; commands: Command[]; readHash: string; expiresAt: number };
const previews = new Map<string, PreviewTicket>();
let commandQueue = Promise.resolve();
/** SQLite has one writer. Queue local commands so concurrent retries read the first
 * committed receipt, while the database unique key remains the final safeguard. */
function commandTransaction<T>(run: (tx: Db) => Promise<T>): Promise<T> {
  const result = commandQueue.then(() => prisma.$transaction(run, { timeout: 30_000 }));
  commandQueue = result.then(() => undefined, () => undefined);
  return result;
}
function normalizeCommands(commands: z.infer<typeof editedCommandSchema>[], previous: Command[] = []): Command[] {
  const references = new Map<string, string>();
  const trustedCreates = new Map(previous.filter((command) => command.kind.endsWith('.create') && command.entityId).map((command) => [command.entityId!, command]));
  const trustedReferences = new Map([...trustedCreates.values()].filter((command) => command.clientRef).map((command) => [command.clientRef!, command]));
  const retainedIds = new Set<string>();
  const normalized: Command[] = commands.map((command) => {
    const kind = alias[command.kind] ?? command.kind;
    let entityId: string | undefined;
    if (command.entityId) {
      const trusted = trustedCreates.get(command.entityId);
      if (!trusted || trusted.kind !== kind) throw new DomainError('INVALID_REFERENCE', '创建对象ID不属于此提议或命令类型已变化', 400);
      entityId = trusted.entityId;
    } else if (kind.endsWith('.create')) {
      const trusted = command.clientRef ? trustedReferences.get(command.clientRef) : undefined;
      entityId = trusted?.kind === kind ? trusted.entityId : randomUUID();
    }
    if (entityId) {
      if (retainedIds.has(entityId)) throw new DomainError('INVALID_REFERENCE', '一个创建对象ID只能对应一条命令', 400);
      retainedIds.add(entityId);
    }
    if (command.clientRef) {
      if (!entityId || references.has(command.clientRef)) throw new DomainError('INVALID_REFERENCE', 'clientRef必须唯一且用于创建命令', 400);
      references.set(command.clientRef, entityId);
    }
    return { ...command, kind, ...(entityId ? { entityId } : {}) };
  });
  if (normalized.length > 1 && normalized.some((command) => ['task.permanent_delete', 'change.undo'].includes(command.kind))) throw new DomainError('INVALID_BATCH', '永久删除和撤销必须作为独立操作提交', 400);
  const targets = normalized.filter((command) => command.targetId && !command.kind.startsWith('task.') && !command.kind.startsWith('topic.')).map((command) => `${command.kind.split('.')[0]}:${command.targetId}`);
  if (new Set(targets).size !== targets.length) throw new DomainError('INVALID_BATCH', '同一材料或记忆在一个批次只能修改一次', 400);
  const referenceFields = new Set(['id', 'topicId', 'parentId', 'taskId', 'materialId', 'memoryId', 'tagIds', 'taskIds', 'materialIds', 'memoryIds', 'orderedTaskIds']);
  const dependencies = normalized.map(() => new Set<string>());
  const trackReference = (id: string, dependencies: Set<string>) => {
    if (trustedCreates.has(id) && !retainedIds.has(id)) throw new DomainError('INVALID_REFERENCE', '仍有命令引用已删除的创建对象，请先移除或调整依赖', 400);
    if (retainedIds.has(id)) dependencies.add(id);
  };
  const resolve = (value: unknown, dependencies: Set<string>, field?: string): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value) && '$ref' in value) {
      const id = references.get(String(value.$ref));
      if (!id) throw new DomainError('INVALID_REFERENCE', '找不到批次内引用', 400);
      trackReference(id, dependencies);
      return id;
    }
    if (Array.isArray(value)) return value.map((item) => resolve(item, dependencies, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, dependencies, key)]));
    if (typeof value === 'string' && field && referenceFields.has(field)) trackReference(value, dependencies);
    return value;
  };
  const resolved = normalized.map((command, index) => {
    if (command.targetId) trackReference(command.targetId, dependencies[index]);
    return { ...command, input: resolve(command.input, dependencies[index]) as Record<string, unknown> };
  });
  // Keep unrelated commands in their supplied order, but place a referenced
  // creation before its dependents when an editor rearranges the command array.
  const ordered: Command[] = [];
  const remaining = new Set(resolved.map((_, index) => index));
  const available = new Set<string>();
  while (remaining.size) {
    const index = [...remaining].find((candidate) => [...dependencies[candidate]].every((id) => available.has(id)));
    if (index === undefined) throw new DomainError('INVALID_REFERENCE', '批次创建依赖存在循环', 400);
    const command = resolved[index];
    ordered.push(command);
    if (command.entityId) available.add(command.entityId);
    remaining.delete(index);
  }
  return ordered;
}
function requireHandler(command: Command) {
  const handler = handlers.get(command.kind);
  if (!handler) throw new DomainError('UNKNOWN_COMMAND', `不支持的命令: ${command.kind}`, 400);
  return handler;
}
function expectRevision(command: Command, row: { revision: number } | null) {
  if (!row) throw new DomainError('NOT_FOUND', '对象不存在', 404);
  if (command.expectedRevision === undefined) throw new DomainError('PRECONDITION_REQUIRED', '修改已有对象必须携带expectedRevision', 428);
  if (row.revision !== command.expectedRevision) throw new DomainError('VERSION_CONFLICT', '对象已有后续修改，请重新读取并确认');
}
async function freshActor(tx: Db, actor: Actor) {
  if (actor.kind !== 'connection') return actor;
  const row = await tx.connection.findUnique({ where: { id: actor.connectionId } });
  if (!row || row.status !== 'active') throw new DomainError('CONNECTION_REVOKED', '连接已撤销', 401);
  return actorFromConnection(row);
}
/** Stored previews and receipts must satisfy current visibility as well as the
 * grant revision. Moving a task out of a grant does not change that grant. */
export async function assertPayloadVisible(tx: Db, actor: Actor, value: unknown) {
  if (actor.kind === 'user') return;
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const row = item as Record<string, unknown>;
    if ('topicId' in row && (row.topicId === null || typeof row.topicId === 'string')) assertTopicAccess(actor, row.topicId);
    if (typeof row.id === 'string') ids.add(row.id);
    if (typeof row.targetId === 'string') ids.add(row.targetId);
    for (const [key, field] of Object.entries(row)) {
      if (typeof field === 'string' && ['beforeSnapshot', 'afterSnapshot', 'snapshot', 'evidence'].includes(key)) { try { visit(JSON.parse(field)); } catch (error) { if (error instanceof DomainError) throw error; } }
      else visit(field);
    }
  };
  visit(value);
  if (!ids.size) return;
  const where = { id: { in: [...ids] } };
  const [tasks, materials, memories, topics] = await Promise.all([tx.task.findMany({ where, select: { topicId: true } }), tx.material.findMany({ where, select: { topicId: true } }), tx.memory.findMany({ where, select: { topicId: true } }), tx.topic.findMany({ where, select: { id: true } })]);
  for (const row of [...tasks, ...materials, ...memories]) assertTopicAccess(actor, row.topicId);
  for (const row of topics) assertTopicAccess(actor, row.id);
}
function autoActions(command: Command) {
  if (command.kind !== 'task.update') return [requireHandler(command).autoAction ?? command.kind];
  const fields: Record<string, string> = { title: 'task.content', description: 'task.content', dueDate: 'task.schedule', priority: 'task.schedule', status: 'task.complete', completeChildren: 'task.complete', resultSummary: 'task.result', topicId: 'task.move', parentId: 'task.move', tagIds: 'task.tags' };
  return [...new Set(Object.keys(command.input).filter((key) => key in fields).map((key) => fields[key]))];
}
function canApply(actor: Actor, commands: Command[]) {
  return actor.kind === 'user' || actor.kind === 'connection' && commands.every((command) => !requireHandler(command).forceProposal && autoActions(command).length > 0 && autoActions(command).every((action) => actor.autoActions.includes(action)));
}
export async function executeInTransaction(tx: Db, actor: Actor, command: Command, context: Partial<MutationContext> = {}) {
  const handler = requireHandler(command);
  if (handler.ownerOnly) assertOwner(actor);
  await handler.inspect(tx, actor, command);
  if (command.evidence?.length) {
    if (!evidenceValidator) throw new DomainError('EVIDENCE_UNAVAILABLE', '证据校验模块不可用', 503);
    await evidenceValidator(tx, actor, command.evidence);
  }
  return handler.execute(tx, actor, command, { source: actor.kind === 'user' ? 'user' : 'agent', ...context, actor, db: tx, entityId: command.entityId });
}

// Workspace inspections capture dependency versions and complete relation scopes.
// This is also the persisted read-set for delayed approval; it is never refreshed silently.
async function inspectWorkspace(tx: Db, actor: Actor, command: Command): Promise<Inspection> {
  const [entity, action] = command.kind.split('.');
  const rows = new Map<string, unknown>();
  const scopes: unknown[] = [];
  const touchedTasks = new Map<string, any>();
  const topic = async (id: string | null) => {
    assertTopicAccess(actor, id);
    if (!id) return;
    const row = await tx.topic.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND', '清单不存在', 404);
    rows.set(`topic:${id}`, row);
  };
  const task = async (id: string) => {
    const row = await tx.task.findUnique({ where: { id }, include: { tags: { orderBy: { tagId: 'asc' } } } });
    if (!row) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    assertTopicAccess(actor, row.topicId);
    rows.set(`task:${id}`, row);
    touchedTasks.set(id, row);
    await topic(row.topicId);
    return row;
  };
  const taskScope = async (where: Record<string, unknown>, kind: string) => {
    const members = await tx.task.findMany({ where, orderBy: { id: 'asc' } });
    scopes.push({ kind, where, members: members.map((row) => ({ id: row.id, revision: row.revision, sortOrder: row.sortOrder })) });
    for (const row of members) { assertTopicAccess(actor, row.topicId); rows.set(`task:${row.id}`, row); touchedTasks.set(row.id, row); }
  };
  let before: unknown = null;
  if (entity === 'task') {
    if (action === 'create') parseInput(taskCreateSchema, command.input);
    if (action === 'update') parseInput(taskUpdateSchema, command.input);
    if (action === 'reorder') {
      const input = parseInput(reorderSchema, command.input);
      await topic(input.topicId);
      const members = await tx.task.findMany({ where: { topicId: input.topicId, parentId: input.parentId, deletedAt: null }, orderBy: { id: 'asc' } });
      const expected = command.input.expectedRevisions as Record<string, number> | undefined;
      if (!expected) throw new DomainError('PRECONDITION_REQUIRED', '排序需要完整成员expectedRevisions', 428);
      if (members.length !== input.orderedTaskIds.length || members.some((row) => !input.orderedTaskIds.includes(row.id) || expected[row.id] !== row.revision)) throw new DomainError('VERSION_CONFLICT', '排序范围已变化，请刷新');
      await taskScope({ topicId: input.topicId, parentId: input.parentId, deletedAt: null }, 'order');
      if (input.parentId) await task(input.parentId);
    } else if (action !== 'create') {
      if (['restore', 'permanent_delete'].includes(action) && !await tx.task.findUnique({ where: { id: command.targetId ?? '' } })) throw new DomainError('TASK_NOT_DELETED', '任务不在回收站');
      const row = await task(command.targetId ?? '');
      expectRevision(command, row);
      before = row;
      if (action === 'restore' && row.topicId && (await tx.topic.findUnique({ where: { id: row.topicId } }))?.archivedAt) { await topic(null); await taskScope({ topicId: null, parentId: null, deletedAt: null }, 'order'); }
      if (row.parentId) await task(row.parentId);
      await taskScope({ parentId: row.id }, 'children');
      if (['delete', 'restore'].includes(action) || 'topicId' in command.input || 'parentId' in command.input) await taskScope({ topicId: row.topicId, parentId: row.parentId, deletedAt: null }, 'order');
    }
    const parentId = typeof command.input.parentId === 'string' ? command.input.parentId : null;
    let destination = 'topicId' in command.input ? command.input.topicId as string | null : action === 'create' ? null : undefined;
    if (parentId) {
      const parent = await task(parentId);
      if (command.input.expectedParentRevision !== undefined && command.input.expectedParentRevision !== parent.revision) throw new DomainError('VERSION_CONFLICT', '父任务已变化');
      if (!('topicId' in command.input)) destination = parent.topicId;
      await taskScope({ parentId }, 'children');
    }
    if (destination !== undefined) { await topic(destination); await taskScope({ topicId: destination, parentId, deletedAt: null }, 'order'); }
    for (const id of Array.isArray(command.input.tagIds) ? command.input.tagIds as string[] : []) {
      const tag = await tx.tag.findUnique({ where: { id } });
      if (!tag) throw new DomainError('NOT_FOUND', '标签不存在', 404);
      if (actor.topicIds !== 'all') {
        const visible = await tx.taskTag.count({ where: { tagId: id, task: { OR: [{ topicId: { in: actor.topicIds } }, ...(actor.includeInbox ? [{ topicId: null }] : [])] } } });
        if (!visible) throw new DomainError('SCOPE_DENIED', '标签不在授权范围内', 403);
      }
      rows.set(`tag:${id}`, tag);
    }
  } else if (entity === 'topic') {
    if (action === 'create') {
      parseInput(topicCreateSchema, command.input);
      if (actor.topicIds !== 'all') throw new DomainError('SCOPE_DENIED', '此连接不能创建工作区清单', 403);
    } else {
      await topic(command.targetId ?? '');
      const row = await tx.topic.findUnique({ where: { id: command.targetId } });
      expectRevision(command, row);
      before = row;
      if (action === 'update') parseInput(topicUpdateSchema, command.input);
      await taskScope({ topicId: command.targetId }, 'topic');
      if (['move_tasks_to_inbox', 'legacy_delete'].includes(action)) { assertTopicAccess(actor, null); await taskScope({ topicId: null, parentId: null, deletedAt: null }, 'order'); }
    }
  } else if (entity === 'tag') {
    assertOwner(actor);
    if (action !== 'delete') parseInput(tagSchema, command.input);
    if (action !== 'create') {
      const tag = await tx.tag.findUnique({ where: { id: command.targetId } });
      expectRevision(command, tag);
      before = tag;
      rows.set(`tag:${command.targetId}`, tag);
      await taskScope({ tags: { some: { tagId: command.targetId } } }, 'tag');
    }
  }
  return {
    preconditions: { rows: [...rows].sort(([a], [b]) => a.localeCompare(b)), scopes },
    preview: { kind: command.kind, targetId: command.targetId ?? command.entityId, before, input: command.input, affectedTasks: [...touchedTasks.values()].map((row) => ({ id: row.id, title: row.title, status: row.status, revision: row.revision, topicId: row.topicId })) },
  };
}
const tasks = new TaskService();
const topics = new TopicService();
const tags = new TagService();
const workspaceExecutors: Record<string, (command: Command, context: MutationContext) => Promise<unknown>> = {
  'task.create': (c, x) => tasks.create(c.input, x), 'task.update': (c, x) => tasks.update(c.targetId!, c.input, x),
  'task.delete': (c, x) => tasks.remove(c.targetId!, x), 'task.restore': (c, x) => tasks.restore(c.targetId!, x),
  'task.permanent_delete': (c, x) => tasks.permanentDelete(c.targetId!, x), 'task.reorder': (c, x) => tasks.reorder(c.input, x),
  'topic.create': (c, x) => topics.create(c.input, x), 'topic.update': (c, x) => topics.update(c.targetId!, c.input, x),
  'topic.archive': (c, x) => topics.archive(c.targetId!, x), 'topic.restore': (c, x) => topics.restore(c.targetId!, x),
  'topic.legacy_delete': (c, x) => topics.remove(c.targetId!, x), 'topic.move_tasks_to_inbox': (c, x) => topics.moveTasksToInbox(c.targetId!, x),
  'topic.confirm_summary': (c, x) => topics.confirmSummary(c.targetId!, x), 'topic.discard_summary': (c, x) => topics.discardSummary(c.targetId!, x),
  'tag.create': (c, x) => tags.create(c.input, x), 'tag.update': (c, x) => tags.update(c.targetId!, c.input, x), 'tag.delete': (c, x) => tags.remove(c.targetId!, x),
};
for (const [kind, execute] of Object.entries(workspaceExecutors)) registerCommandHandler(kind, { inspect: inspectWorkspace, execute: async (_tx, _actor, command, context) => execute(command, context), ownerOnly: kind === 'task.permanent_delete' || kind.startsWith('tag.') });
registerCommandHandler('change.undo', {
  ownerOnly: true,
  inspect: async (tx, _actor, command) => {
    const record = await tx.changeRecord.findUnique({ where: { id: command.targetId } });
    if (!record) throw new DomainError('NOT_FOUND', '变更不存在', 404);
    return { preconditions: record, preview: { kind: 'change.undo', changeId: record.id, operation: record.operation } };
  },
  execute: async (_tx, _actor, command, context) => new ChangeService().undo(command.targetId!, context),
});

function mergeWorkspaceSnapshots(changes: Array<{ beforeSnapshot: string | null; afterSnapshot: string | null }>) {
  const before: GroupSnapshot = { version: 2, entities: { tasks: {}, topics: {}, tags: {} }, scopes: [] };
  const after: GroupSnapshot = structuredClone(before);
  for (const change of changes) {
    const left = change.beforeSnapshot ? JSON.parse(change.beforeSnapshot) : null;
    const right = change.afterSnapshot ? JSON.parse(change.afterSnapshot) : null;
    if (!isGroup(left) || !isGroup(right)) return null;
    for (const kind of ['tasks', 'topics', 'tags'] as const) {
      for (const [id, value] of Object.entries(left.entities[kind])) if (!(id in before.entities[kind])) (before.entities[kind] as Record<string, unknown>)[id] = value;
      Object.assign(after.entities[kind], right.entities[kind]);
    }
    for (const scope of left.scopes) if (!before.scopes.some((entry) => canonical(entry.scope) === canonical(scope.scope))) before.scopes.push(scope);
    for (const scope of right.scopes) { const index = after.scopes.findIndex((entry) => canonical(entry.scope) === canonical(scope.scope)); if (index < 0) after.scopes.push(scope); else after.scopes[index] = scope; }
  }
  return { before, after };
}
async function executeBatch(tx: Db, actor: Actor, commands: Command[], proposalId?: string, audit: Pick<MutationContext, 'conversationId' | 'approvalId'> = {}) {
  const changes: ChangeRecord[] = [];
  const results: unknown[] = [];
  for (const command of commands) results.push(await requireHandler(command).execute(tx, actor, command, { ...audit, source: actor.kind === 'user' ? 'user' : 'agent', actor, db: tx, proposalId, entityId: command.entityId, auditRecords: changes }));
  let changeId = changes[0]?.id;
  if (changes.length > 1) {
    const merged = mergeWorkspaceSnapshots(changes);
    const workspace = changes.filter((row) => isGroup(row.beforeSnapshot ? JSON.parse(row.beforeSnapshot) : null) && isGroup(row.afterSnapshot ? JSON.parse(row.afterSnapshot) : null));
    const combinedWorkspace = workspace.length ? mergeWorkspaceSnapshots(workspace)! : null;
    const parts = changes.filter((row) => !workspace.includes(row));
    if (combinedWorkspace) parts.unshift({ ...workspace[0], entityType: 'workspace', operation: 'batch', beforeSnapshot: JSON.stringify(combinedWorkspace.before), afterSnapshot: JSON.stringify(combinedWorkspace.after) });
    await tx.changeRecord.deleteMany({ where: { id: { in: changes.map((row) => row.id) } } });
    const record = await tx.changeRecord.create({ data: { entityType: merged ? 'workspace' : 'proposal', entityId: proposalId ?? randomUUID(), operation: commands[0].kind === 'change.undo' ? 'undo:batch' : 'batch', beforeSnapshot: JSON.stringify(merged?.before ?? { version: 3, changes: parts.map((row) => ({ entityType: row.entityType, entityId: row.entityId, operation: row.operation, snapshot: row.beforeSnapshot })) }), afterSnapshot: JSON.stringify(merged?.after ?? { version: 3, changes: parts.map((row) => ({ entityType: row.entityType, entityId: row.entityId, operation: row.operation, snapshot: row.afterSnapshot })) }), source: actor.kind === 'user' ? 'user' : 'agent', actorId: actor.id, connectionId: actor.connectionId, proposalId, createdAt: now() } });
    changeId = record.id;
  }
  const affectedTaskIds = [...new Set(results.flatMap((result: any) => result?.meta?.affectedTaskIds ?? []))];
  const normalizedResults = results.map((result: any) => result && typeof result === 'object' && result.meta ? { ...result, meta: { ...result.meta, changeId } } : result);
  return { results: normalizedResults, changeId, meta: { changeId, affectedTaskIds } };
}

async function inspectBatch(tx: Db, actor: Actor, commands: Command[]) {
  const inspections: Inspection[] = [];
  const evidenceReadsets: unknown[] = [];
  for (const command of commands) {
    if (command.evidence?.length && !evidenceValidator) throw new DomainError('EVIDENCE_UNAVAILABLE', '证据校验模块不可用', 503);
    evidenceReadsets.push(command.evidence?.length ? await evidenceValidator!(tx, actor, command.evidence) : undefined);
  }
  // Domain handlers perform database work only. A savepoint runs exactly the same
  // rules used at commit, including dependencies on earlier creates in this batch.
  await tx.$executeRawUnsafe('SAVEPOINT command_preview');
  try {
    for (const [index, command] of commands.entries()) {
      const handler = requireHandler(command);
      if (handler.ownerOnly) assertOwner(actor);
      const inspected = await handler.inspect(tx, actor, command);
      const evidence = evidenceReadsets[index];
      const after = await handler.execute(tx, actor, command, { source: actor.kind === 'user' ? 'user' : 'agent', actor, db: tx, entityId: command.entityId, preview: true });
      inspections.push({ preconditions: stablePreconditions({ command: inspected.preconditions, evidence }), preview: { detail: inspected.preview, after } });
    }
    return inspections;
  } finally {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT command_preview');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT command_preview');
  }
}
function needsPreview(commands: Command[], inspections: Inspection[]) {
  return commands.some((command, index) => {
    const preview = inspections[index].preview as any;
    const ids: string[] = preview.after?.meta?.affectedTaskIds ?? [];
    if (command.kind === 'task.reorder') return false;
    if (command.kind === 'task.create') return ids.some((id) => id !== command.entityId);
    if (command.kind.startsWith('task.')) return ids.some((id) => id !== command.targetId);
    if (['topic.archive', 'topic.restore', 'topic.move_tasks_to_inbox', 'topic.legacy_delete', 'tag.delete'].includes(command.kind)) return preview.detail?.affectedTasks?.length > 0;
    return false;
  });
}
function stablePreconditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePreconditions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['createdAt', 'updatedAt', 'deleteBatchId'].includes(key)).map(([key, entry]) => [key, stablePreconditions(entry)]));
  return value;
}
export class CommandService {
  async preview(actor: Actor, value: unknown) {
    const { commands: raw } = z.object({ commands: z.array(commandSchema).min(1).max(50) }).parse(value);
    const commands = normalizeCommands(raw);
    return commandTransaction(async (tx) => {
      const current = await freshActor(tx, actor);
      const inspections = await inspectBatch(tx, current, commands);
      for (const [key, ticket] of previews) if (ticket.expiresAt < Date.now()) previews.delete(key);
      if (previews.size > 1000) previews.delete(previews.keys().next().value!);
      const previewToken = randomUUID();
      previews.set(previewToken, { actorId: current.id, scopeRevision: current.revision, requestHash: digest(raw), commands, readHash: digest(inspections.map((item) => item.preconditions)), expiresAt: Date.now() + 10 * 60_000 });
      return { commands, preview: inspections.map((inspection) => inspection.preview), previewToken, requiresConfirmation: needsPreview(commands, inspections) };
    });
  }
  async submit(actor: Actor, value: unknown, options: { forceProposal?: boolean; audit?: Pick<MutationContext, 'conversationId' | 'approvalId'> } = {}): Promise<any> {
    const input = submitSchema.parse(value);
    const requestHash = digest(input.commands);
    const response = await commandTransaction(async (tx) => {
      const current = await freshActor(tx, actor);
      const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: current.id, requestId: input.requestId } } });
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
        const saved = JSON.parse(receipt.response);
        if (saved.scopeRevision !== current.revision) throw new DomainError('SCOPE_CHANGED', '连接授权已变化，不能重放旧结果', 403);
        await assertPayloadVisible(tx, current, saved.result);
        return saved.result;
      }
      const ticket = input.previewToken ? previews.get(input.previewToken) : undefined;
      if (input.previewToken && (!ticket || ticket.expiresAt < Date.now() || ticket.actorId !== current.id || ticket.scopeRevision !== current.revision || ticket.requestHash !== requestHash)) throw new DomainError('PREVIEW_EXPIRED', '预览已过期或提交内容已变化，请重新预览');
      const commands = ticket?.commands ?? normalizeCommands(input.commands);
      const inspections = await inspectBatch(tx, current, commands);
      if (ticket && ticket.readHash !== digest(inspections.map((item) => item.preconditions))) throw new DomainError('VERSION_CONFLICT', '预览后对象或完整关系集合发生了变化，请重新预览');
      if (current.kind === 'user' && !ticket && needsPreview(commands, inspections)) throw Object.assign(new DomainError('PREVIEW_REQUIRED', '此操作会同时影响关联任务，需要先确认完整变更预览', 428), { details: { commands: input.commands } });
      let result: any;
      // Automatic grants cover the requested task's fields. Effects on related
      // tasks always need owner confirmation, even with a valid preview ticket.
      const connectionCascade = current.kind === 'connection' && needsPreview(commands, inspections);
      if (!options.forceProposal && !connectionCascade && canApply(current, commands)) result = { status: 'applied', requestId: input.requestId, ...await executeBatch(tx, current, commands, undefined, options.audit) };
      else {
        const timestamp = now();
        const proposal = await tx.proposal.create({ data: { actorId: current.id, connectionId: current.connectionId, commands: JSON.stringify(commands), preconditions: JSON.stringify({ actor: current, audit: options.audit, inspections: inspections.map((item) => item.preconditions) }), preview: JSON.stringify(inspections.map((item) => item.preview)), createdAt: timestamp, updatedAt: timestamp } });
        result = { status: 'pending_approval', requestId: input.requestId, proposalId: proposal.id, proposalRevision: proposal.revision, preview: JSON.parse(proposal.preview) };
      }
      await tx.requestReceipt.create({ data: { actorId: current.id, requestId: input.requestId, requestHash, response: JSON.stringify({ result, scopeRevision: current.revision }), createdAt: now() } });
      return result;
    });
    publishWorkspaceChange({ kind: response.status, proposalId: response.proposalId, ...response.meta });
    return response;
  }
  async get(actor: Actor, id: string) {
    const row = await prisma.proposal.findUnique({ where: { id } });
    if (!row || actor.kind !== 'user' && row.actorId !== actor.id) throw new DomainError('NOT_FOUND', '提议不存在', 404);
    const current = await prisma.$transaction((tx) => freshActor(tx, actor));
    const stored = JSON.parse(row.preconditions);
    if (current.kind === 'connection' && current.revision !== stored.actor.revision) throw new DomainError('SCOPE_CHANGED', '连接授权已变化', 403);
    await assertPayloadVisible(prisma, current, { commands: JSON.parse(row.commands), preview: JSON.parse(row.preview), result: row.result ? JSON.parse(row.result) : null });
    return { ...row, commands: JSON.parse(row.commands), preview: JSON.parse(row.preview), result: row.result ? JSON.parse(row.result) : null, preconditions: undefined };
  }
  async list(actor: Actor, status?: string) {
    const mapped = status === 'applied' ? 'executed' : status;
    return Promise.all((await prisma.proposal.findMany({ where: { ...(actor.kind === 'user' ? {} : { actorId: actor.id }), ...(mapped ? { status: mapped } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 })).map((row) => this.get(actor, row.id)));
  }
  async edit(actor: Actor, id: string, value: unknown) {
    assertOwner(actor);
    const input = z.object({ expectedRevision: z.number().int().min(1), commands: z.array(editedCommandSchema).min(1).max(50) }).parse(value);
    await commandTransaction(async (tx) => {
      const row = await tx.proposal.findUnique({ where: { id } });
      if (!row || row.status !== 'pending' || row.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', '提议已变化');
      const stored = JSON.parse(row.preconditions);
      const initiator = await freshActor(tx, stored.actor);
      const commands = normalizeCommands(input.commands, JSON.parse(row.commands) as Command[]);
      const inspections = await inspectBatch(tx, initiator, commands);
      await tx.proposal.update({ where: { id }, data: { commands: JSON.stringify(commands), preconditions: JSON.stringify({ actor: initiator, audit: stored.audit, inspections: inspections.map((item) => item.preconditions) }), preview: JSON.stringify(inspections.map((item) => item.preview)), revision: { increment: 1 }, updatedAt: now() } });
    });
    return this.get(actor, id);
  }
  async approve(actor: Actor, id: string, value: unknown): Promise<any> {
    assertOwner(actor);
    const input = z.object({ expectedRevision: z.number().int().min(1), requestId: z.string().min(1) }).parse(value);
    const requestHash = digest({ proposalId: id, ...input });
    const result = await commandTransaction(async (tx) => {
      const receipt = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: actor.id, requestId: input.requestId } } });
      if (receipt) { if (receipt.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求标识已用于其他内容'); return JSON.parse(receipt.response).result; }
      const row = await tx.proposal.findUnique({ where: { id } });
      if (!row || row.status !== 'pending' || row.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', '提议已处理或发生变化');
      const stored = JSON.parse(row.preconditions);
      const initiator = await freshActor(tx, stored.actor);
      if (initiator.revision !== stored.actor.revision) throw new DomainError('SCOPE_CHANGED', '原连接授权已变化，请重新预览');
      const commands: Command[] = JSON.parse(row.commands);
      const inspected = await inspectBatch(tx, initiator, commands);
      if (canonical(inspected.map((item) => item.preconditions)) !== canonical(stored.inspections)) throw new DomainError('VERSION_CONFLICT', '提议中的对象或关系已变化，请重新预览');
      const result = { status: 'applied', requestId: input.requestId, proposalId: id, ...await executeBatch(tx, initiator, commands, id, stored.audit) };
      await tx.proposal.update({ where: { id }, data: { status: 'executed', revision: { increment: 1 }, result: JSON.stringify(result), updatedAt: now() } });
      await tx.requestReceipt.create({ data: { actorId: actor.id, requestId: input.requestId, requestHash, response: JSON.stringify({ result, scopeRevision: actor.revision }), createdAt: now() } });
      return result;
    });
    publishWorkspaceChange({ kind: 'applied', proposalId: id, ...result.meta });
    return result;
  }
  async reject(actor: Actor, id: string, value: unknown) {
    assertOwner(actor);
    const input = z.object({ expectedRevision: z.number().int().min(1) }).parse(value);
    const result = await prisma.proposal.updateMany({ where: { id, status: 'pending', revision: input.expectedRevision }, data: { status: 'rejected', revision: { increment: 1 }, updatedAt: now() } });
    if (!result.count) throw new DomainError('VERSION_CONFLICT', '提议已处理或发生变化');
    publishWorkspaceChange({ kind: 'proposal', proposalId: id });
    return this.get(actor, id);
  }
}

const service = new CommandService();
const send = (res: any, data: unknown) => res.json({ data, error: null });
export const commandsRouter = Router();
commandsRouter.get('/tools', (_req, res) => send(res, [...handlers].map(([kind, handler]) => ({ kind, ownerOnly: handler.ownerOnly ?? false, forceProposal: handler.forceProposal ?? false, ...commandDescriptor(kind), ...(handler.inputSchema ? { input: handler.inputSchema } : {}), ...(handler.description ? { description: handler.description } : {}) }))));
commandsRouter.post('/commands', async (req, res, next) => { try { send(res, await service.submit(getActor(req), req.body)); } catch (error) { next(error); } });
commandsRouter.post('/commands/preview', async (req, res, next) => { try { send(res, await service.preview(getActor(req), req.body)); } catch (error) { next(error); } });
commandsRouter.get('/proposals', async (req, res, next) => { try { send(res, await service.list(getActor(req), typeof req.query.status === 'string' ? req.query.status : undefined)); } catch (error) { next(error); } });
commandsRouter.get('/proposals/:id', async (req, res, next) => { try { send(res, await service.get(getActor(req), String(req.params.id))); } catch (error) { next(error); } });
commandsRouter.patch('/proposals/:id', async (req, res, next) => { try { send(res, await service.edit(getActor(req), String(req.params.id), req.body)); } catch (error) { next(error); } });
commandsRouter.post('/proposals/:id/approve', async (req, res, next) => { try { send(res, await service.approve(getActor(req), String(req.params.id), req.body)); } catch (error) { next(error); } });
commandsRouter.post('/proposals/:id/reject', async (req, res, next) => { try { send(res, await service.reject(getActor(req), String(req.params.id), req.body)); } catch (error) { next(error); } });
commandsRouter.get('/events', (req, res, next) => {
  try {
    assertOwner(getActor(req));
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    const listener = (event: unknown) => res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    workspaceEvents.on('change', listener);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => { clearInterval(heartbeat); workspaceEvents.off('change', listener); });
  } catch (error) { next(error); }
});
