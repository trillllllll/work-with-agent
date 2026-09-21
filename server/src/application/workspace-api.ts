import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { getActor, assertTopicAccess, type Actor } from './security.js';
import { CommandService, canonical, assertPayloadVisible, type Command } from './commands.js';
import { taskDto, taskInclude } from './workspace-store.js';
import { TaskService, TopicService, ChangeService } from './workspace.js';
import { taskListSchema, parseInput } from './workspace-input.js';

const commands = new CommandService();
function revision(req: Request) {
  const value = req.body?.expectedRevision ?? req.headers['if-match']?.replaceAll('"', '');
  return value === undefined ? undefined : Number(value);
}
/** Owner compatibility endpoints retain their data envelopes, never an auth bypass. */
export async function legacyMutationMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  let command: Command | undefined;
  const path = req.originalUrl.split('?')[0];
  const input = req.body && typeof req.body === 'object' ? { ...req.body } : {};
  delete input.expectedRevision; delete input.requestId; delete input.previewToken;
  const match = path.match(/^\/api\/(tasks|topics|tags)\/([^/]+)(?:\/(.+))?$/);
  const trash = path.match(/^\/api\/trash\/tasks\/([^/]+)\/(restore|permanent)$/);
  const undo = path.match(/^\/api\/changes\/([^/]+)\/undo$/);
  if (req.method === 'POST' && path === '/api/tasks/reorder') command = { kind: 'task.reorder', input };
  else if (req.method === 'POST' && /^\/api\/(tasks|topics|tags)$/.test(path)) command = { kind: `${path.slice(5, -1)}.create`, input };
  else if (trash) command = { kind: trash[2] === 'restore' ? 'task.restore' : 'task.permanent_delete', targetId: trash[1], expectedRevision: revision(req), input };
  else if (undo) command = { kind: 'change.undo', targetId: undo[1], input };
  else if (match) {
    const entity = match[1].slice(0, -1);
    const action = match[3];
    let operation: string | undefined;
    if (req.method === 'PATCH' && !action) operation = 'update';
    if (req.method === 'DELETE' && !action) operation = entity === 'topic' ? 'legacy_delete' : 'delete';
    if (req.method === 'POST' && entity === 'topic') {
      operation = ({ archive: 'archive', restore: 'restore', 'move-tasks-to-inbox': 'move_tasks_to_inbox', 'summary/confirm': 'confirm_summary', 'summary/discard': 'discard_summary', 'summary/generate': 'update' } as Record<string, string>)[action];
      if (action === 'summary/generate') { input.draftSummary = z.string().trim().min(1).parse(input.summary); delete input.summary; }
    }
    if (operation) command = { kind: `${entity}.${operation}`, targetId: match[2], expectedRevision: revision(req), input };
  }
  if (!command) return next();
  try {
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : typeof req.body?.requestId === 'string' ? req.body.requestId : randomUUID();
    const result = await commands.submit(getActor(req), { requestId, commands: [command], previewToken: req.body?.previewToken });
    const value = result.results?.[0] ?? result;
    if (value && typeof value === 'object' && 'meta' in value) { const { meta, ...data } = value; res.json({ data, error: null, meta }); }
    else res.json({ data: value, error: null, meta: result.meta });
  } catch (error) { next(error); }
}

export const workspaceQueryRouter = Router();
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
function taskScope(actor: Actor): Prisma.TaskWhereInput {
  return actor.topicIds === 'all' ? (actor.includeInbox ? {} : { topicId: { not: null } }) : { OR: [{ topicId: { in: actor.topicIds } }, ...(actor.includeInbox ? [{ topicId: null }] : [])] };
}
const canReadTopic = (actor: Actor, topicId: string | null) => topicId === null ? actor.includeInbox : actor.topicIds === 'all' || actor.topicIds.includes(topicId);
function page<T extends { id: string }>(rows: T[], query: { limit: number; cursor?: string }, fingerprint: string) {
  let index = 0;
  if (query.cursor) {
    let value: any;
    try { value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new DomainError('INVALID_CURSOR', '分页游标无效', 400); }
    if (value.filter !== fingerprint) throw new DomainError('INVALID_CURSOR', '游标不属于当前查询', 400);
    index = rows.findIndex((row) => row.id === value.id) + 1;
    if (!index) throw new DomainError('CURSOR_STALE', '分页对象已变化，请从首页重新查询');
  }
  const items = rows.slice(index, index + query.limit);
  const hasMore = index + items.length < rows.length;
  return { items, hasMore, nextCursor: hasMore && items.length ? Buffer.from(JSON.stringify({ filter: fingerprint, id: items.at(-1)!.id })).toString('base64url') : null };
}
workspaceQueryRouter.get('/tasks', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const paging = pageSchema.parse(req.query);
    const topicId = typeof req.query.topicId === 'string' ? req.query.topicId : undefined;
    if (topicId) assertTopicAccess(actor, topicId);
    if (req.query.inbox === 'true') assertTopicAccess(actor, null);
    const query = parseInput(taskListSchema, { ...req.query, inbox: req.query.inbox === 'true', includeArchived: req.query.includeArchived === 'true', tagIds: typeof req.query.tagIds === 'string' ? req.query.tagIds.split(',').filter(Boolean) : undefined });
    // Apply visibility in the database before filtering or pagination. Scoped callers
    // never receive a full-workspace array through this query path.
    const allowed = actor.topicIds === 'all' ? undefined : { OR: [{ topicId: { in: actor.topicIds } }, ...(actor.includeInbox ? [{ topicId: null }] : [])] };
    const rows = await new TaskService().list(topicId, query, allowed);
    res.json({ data: page(rows, paging, canonical({ actor: actor.id, revision: actor.revision, topicId, query })), error: null });
  } catch (error) { next(error); }
});
workspaceQueryRouter.get('/tasks/:id', async (req, res, next) => {
  try {
    const row = await new TaskService().get(String(req.params.id));
    if (!row) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    assertTopicAccess(getActor(req), row.topicId);
    res.json({ data: row, error: null });
  } catch (error) { next(error); }
});
workspaceQueryRouter.get('/topics', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const paging = pageSchema.parse(req.query);
    const rows = await prisma.topic.findMany({ where: { ...(actor.topicIds !== 'all' ? { id: { in: actor.topicIds } } : {}), archivedAt: req.query.archived === 'true' ? { not: null } : null }, orderBy: { id: 'asc' } });
    res.json({ data: page(rows, paging, canonical({ actor: actor.id, revision: actor.revision, archived: req.query.archived === 'true' })), error: null });
  } catch (error) { next(error); }
});
workspaceQueryRouter.get('/topics/:id', async (req, res, next) => {
  try {
    assertTopicAccess(getActor(req), String(req.params.id));
    const row = await new TopicService().get(String(req.params.id), { includeArchived: req.query.includeArchived === 'true' });
    if (!row) throw new DomainError('NOT_FOUND', '清单不存在', 404);
    res.json({ data: row, error: null });
  } catch (error) { next(error); }
});

workspaceQueryRouter.get('/tags', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const paging = pageSchema.parse(req.query);
    // Tags are global; an external connection only discovers tags actually used
    // by a task within its grant, including recoverable tasks in its trash.
    const rows = await prisma.tag.findMany({ where: actor.kind === 'user' ? {} : { tasks: { some: { task: taskScope(actor) } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    res.json({ data: page(rows, paging, canonical({ route: 'tags', actor: actor.id, revision: actor.revision })), error: null });
  } catch (error) { next(error); }
});

workspaceQueryRouter.get('/trash/tasks', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const query = pageSchema.extend({ topicId: z.string().min(1).optional(), inbox: z.enum(['true', 'false']).optional() }).parse(req.query);
    if (query.topicId) assertTopicAccess(actor, query.topicId);
    if (query.inbox === 'true') assertTopicAccess(actor, null);
    if (query.topicId && query.inbox === 'true') throw new DomainError('INVALID_INPUT', '不能同时指定清单和收集箱', 400);
    const rows = await prisma.task.findMany({ where: { AND: [taskScope(actor), { deletedAt: { not: null }, ...(query.topicId ? { topicId: query.topicId } : query.inbox === 'true' ? { topicId: null } : {}) }] }, include: taskInclude, orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }] });
    res.json({ data: page(rows.map(taskDto), query, canonical({ route: 'trash', actor: actor.id, revision: actor.revision, topicId: query.topicId, inbox: query.inbox === 'true' })), error: null });
  } catch (error) { next(error); }
});

workspaceQueryRouter.get('/tasks/:id/history', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const paging = pageSchema.parse(req.query);
    const taskId = String(req.params.id);
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { topicId: true } });
    if (!task) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    assertTopicAccess(actor, task.topicId);
    const rows = await prisma.taskTopicAssignment.findMany({ where: { taskId }, include: { fromTopic: { select: { id: true, name: true } }, toTopic: { select: { id: true, name: true } } }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }] });
    const visible = rows.map((row) => {
      if (actor.kind === 'user') return row;
      const fromRedacted = !canReadTopic(actor, row.fromTopicId);
      const toRedacted = !canReadTopic(actor, row.toTopicId);
      return { id: row.id, taskId: row.taskId, source: row.source, changedAt: row.changedAt,
        fromTopicId: fromRedacted ? null : row.fromTopicId, toTopicId: toRedacted ? null : row.toTopicId,
        fromTopic: fromRedacted ? null : row.fromTopic, toTopic: toRedacted ? null : row.toTopic,
        fromRedacted, toRedacted, reason: fromRedacted || toRedacted ? '范围外清单信息已隐藏' : row.reason };
    });
    res.json({ data: page(visible, paging, canonical({ route: 'history', actor: actor.id, revision: actor.revision, taskId })), error: null });
  } catch (error) { next(error); }
});

/** Fail closed for legacy/unknown records. Every historical scope and every
 * currently existing referenced entity must still be visible. Never partially
 * expose a mixed audit group, even when its primary entity is authorized. */
async function visibleChange(actor: Actor, record: { entityType: string; entityId: string; beforeSnapshot: string | null; afterSnapshot: string | null }) {
  if (!['task', 'topic', 'material', 'memory', 'workspace', 'proposal'].includes(record.entityType)) return false;
  let anchored = false;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const item = value as Record<string, any>;
    if ('topicId' in item && (item.topicId === null || typeof item.topicId === 'string')) { assertTopicAccess(actor, item.topicId); anchored = true; }
    if (item.entities) {
      for (const id of Object.keys(item.entities.topics ?? {})) { assertTopicAccess(actor, id); anchored = true; }
      // Global tag edits can affect connections outside a project. They remain
      // owner-only audit entries, including when merged into a workspace batch.
      if (Object.keys(item.entities.tags ?? {}).length) throw new DomainError('SCOPE_DENIED', '全局标签变更仅对用户可见', 403);
    }
    if (item.entityType === 'tag') throw new DomainError('SCOPE_DENIED', '全局标签变更仅对用户可见', 403);
    if (item.kind === 'topic' && typeof item.id === 'string') { assertTopicAccess(actor, item.id); anchored = true; }
    for (const [key, value] of Object.entries(item)) {
      if (key === 'snapshot' && typeof value === 'string') inspect(JSON.parse(value));
      else inspect(value);
    }
  };
  try {
    const snapshots = [record.beforeSnapshot, record.afterSnapshot].map((value) => value ? JSON.parse(value) : null);
    if (record.entityType === 'topic') { assertTopicAccess(actor, record.entityId); anchored = true; }
    snapshots.forEach(inspect);
    await assertPayloadVisible(prisma, actor, { targetId: record.entityId, snapshots });
    return anchored;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof DomainError && error.code === 'SCOPE_DENIED') return false;
    throw error;
  }
}

workspaceQueryRouter.get('/changes', async (req, res, next) => {
  try {
    const actor = getActor(req);
    const query = pageSchema.extend({ entityType: z.string().min(1).optional(), entityId: z.string().min(1).optional() }).parse(req.query);
    const rows = await new ChangeService().list(query.entityType, query.entityId);
    const visible = [];
    for (const row of rows) {
      if (actor.kind === 'user') visible.push(row);
      else if (await visibleChange(actor, row)) {
        const { id, entityType, entityId, operation, source, createdAt, undoneAt, reversible } = row;
        visible.push({ id, entityType, entityId, operation, source, createdAt, undoneAt, reversible });
      }
    }
    res.json({ data: page(visible, query, canonical({ route: 'changes', actor: actor.id, revision: actor.revision, entityType: query.entityType, entityId: query.entityId })), error: null });
  } catch (error) { next(error); }
});
