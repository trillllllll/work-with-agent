import { createHash } from 'node:crypto';
import { DomainError } from '../domain/task.js';
import { canonical } from '../application/commands.js';
import { redact } from '../infrastructure/controlled-execution.js';
import { LibraryService } from '../application/library/service.js';
import { runAgentMemoryTool, validateConversationSearchArguments, validateMemoryArguments } from '../application/agent-memory.js';
import { ownerActor } from '../application/security.js';
import { TaskService, TopicService, TagService } from '../application/workspace.js';
import { queryTaskActivity } from '../application/task-activity.js';
import { prisma } from '../infrastructure/prisma.js';
import { CAPABILITY_UNAVAILABLE, changeSchemaDocument, isBuiltinTool } from './capabilities.js';
import type { StoredChatContext } from './chat-context.js';
import { externalPromptInput, externalPromptPart, renderExternalPrompt } from './external-prompt.js';
import { prepareChanges } from './propose.js';
import { getCurrentTime, type Clock } from './time.js';

const tasks = new TaskService();
const topics = new TopicService();
const tags = new TagService();
const library = new LibraryService();

export type BuiltinResult = { success: boolean; data?: unknown; error?: string; code?: string; approval?: boolean; part?: unknown };

function fail(error: unknown): BuiltinResult {
  if (error instanceof DomainError) return { success: false, code: error.code, error: error.message };
  return { success: false, code: 'TOOL_ERROR', error: error instanceof Error ? error.message : '工具执行失败' };
}

function pageLimit(value: unknown, fallback: number, max: number) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new DomainError('INVALID_TOOL_ARGUMENTS', `limit 需要是 1 到 ${max} 的整数`, 400);
  return limit;
}

function cursorOf(fingerprint: string, offset: number) {
  return Buffer.from(JSON.stringify({ fingerprint, offset })).toString('base64url');
}

function readCursor(cursor: unknown, fingerprint: string) {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string' || !cursor) throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { fingerprint?: string; offset?: number };
    if (decoded.fingerprint !== fingerprint) throw new DomainError('CURSOR_STALE', '查询条件已变化，请从第一页重新读取', 409);
    return decoded.offset ?? 0;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  }
}

function slicePage<T>(rows: T[], fingerprint: string, cursor: unknown, limit: number) {
  const offset = readCursor(cursor, fingerprint);
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, hasMore: next < rows.length, nextCursor: next < rows.length ? cursorOf(fingerprint, next) : null };
}

function scopeTopic(context: StoredChatContext, topicId: unknown) {
  if (topicId === null) return { inbox: true as const };
  if (typeof topicId === 'string') return { topicId };
  if (context.scope.kind === 'inbox') return { inbox: true as const };
  if (context.scope.kind === 'topic') return { topicId: context.scope.topicId };
  return {};
}

async function queryTasks(args: Record<string, unknown>, context: StoredChatContext) {
  const action = args.action;
  if (action === 'tags') {
    const rows = await tags.list();
    return { items: rows.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, revision: tag.revision })) };
  }
  if (action === 'trash') {
    const rows = await tasks.listDeleted();
    const limit = pageLimit(args.limit, 20, 100);
    const fingerprint = createHash('sha256').update(canonical({ action, actor: ownerActor.id })).digest('hex');
    return slicePage(rows, fingerprint, args.cursor, limit);
  }
  if (action === 'assignments') {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (!taskId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'assignments 需要 taskId', 400);
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, topicId: true } });
    if (!task) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    const rows = await prisma.taskTopicAssignment.findMany({
      where: { taskId },
      include: { fromTopic: { select: { id: true, name: true } }, toTopic: { select: { id: true, name: true } } },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      taskId,
      note: '这是清单归属历史，不是任务动态。',
      items: rows.map((row) => ({ id: row.id, at: row.changedAt, fromTopicId: row.fromTopicId, toTopicId: row.toTopicId, fromTopic: row.fromTopic?.name ?? null, toTopic: row.toTopic?.name ?? null, reason: row.reason, source: row.source })),
    };
  }
  if (action === 'get') {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (!taskId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'get 需要 taskId', 400);
    const task = await tasks.get(taskId, { includeDeleted: true });
    if (!task) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    return task;
  }
  if (action !== 'list') throw new DomainError('INVALID_TOOL_ARGUMENTS', 'query_tasks.action 只能是 list、get、tags、trash 或 assignments', 400);
  const scoped = scopeTopic(context, args.topicId);
  const listed = await tasks.list('topicId' in scoped ? scoped.topicId : undefined, {
    ...('inbox' in scoped ? { inbox: true } : {}),
    q: typeof args.q === 'string' ? args.q : undefined,
    status: typeof args.status === 'string' ? args.status as 'open' : undefined,
    dueFrom: typeof args.dueFrom === 'string' ? args.dueFrom : undefined,
    dueTo: typeof args.dueTo === 'string' ? args.dueTo : undefined,
    scheduledFrom: typeof args.scheduledFrom === 'string' ? args.scheduledFrom : undefined,
    scheduledTo: typeof args.scheduledTo === 'string' ? args.scheduledTo : undefined,
    tagIds: Array.isArray(args.tagIds) ? args.tagIds.filter((item): item is string => typeof item === 'string') : undefined,
    sort: typeof args.sort === 'string' ? args.sort as 'manual' : undefined,
    includeArchived: args.includeArchived === true,
    includeDeleted: args.includeDeleted === true,
  });
  const limit = pageLimit(args.limit, 20, 100);
  const fingerprint = createHash('sha256').update(canonical({ action, scoped, q: args.q ?? null, status: args.status ?? null, dueFrom: args.dueFrom ?? null, dueTo: args.dueTo ?? null, scheduledFrom: args.scheduledFrom ?? null, scheduledTo: args.scheduledTo ?? null, tagIds: args.tagIds ?? null, sort: args.sort ?? null, includeArchived: args.includeArchived === true, includeDeleted: args.includeDeleted === true, actor: ownerActor.id })).digest('hex');
  const page = slicePage(listed, fingerprint, args.cursor, limit);
  return { ...page, coverage: { archived: args.includeArchived === true ? 'included' : 'excluded', deleted: args.includeDeleted === true ? 'included' : 'excluded' } };
}

async function queryTopics(args: Record<string, unknown>) {
  if (args.action === 'list') {
    const rows = await topics.list({ archived: args.archived === true });
    return { items: rows.map((topic) => ({ id: topic.id, name: topic.name, archived: Boolean(topic.archivedAt), revision: topic.revision })) };
  }
  if (args.action !== 'get') throw new DomainError('INVALID_TOOL_ARGUMENTS', 'query_topics.action 只能是 list 或 get', 400);
  const topicId = typeof args.topicId === 'string' ? args.topicId : '';
  if (!topicId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'get 需要 topicId', 400);
  const topic = await topics.get(topicId, { includeArchived: true });
  if (!topic) throw new DomainError('NOT_FOUND', '清单不存在', 404);
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0, total: topic.tasks.length };
  for (const task of topic.tasks) {
    if (task.status === 'todo' || task.status === 'doing' || task.status === 'blocked' || task.status === 'done') counts[task.status] += 1;
  }
  return { ...topic, statusCounts: counts };
}

async function libraryRead(args: Record<string, unknown>) {
  const action = String(args.action ?? '');
  if (action === 'ask' || action === 'undo') throw new DomainError('CAPABILITY_UNAVAILABLE', CAPABILITY_UNAVAILABLE.error, 400);
  if (!['list', 'search', 'read', 'content', 'linked_tasks', 'task_materials', 'folders', 'tags'].includes(action)) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'library_read 的动作无效', 400);
  if (action === 'folders') return library.folders(ownerActor);
  if (action === 'tags') return library.tags(ownerActor);
  if (action === 'read') {
    const row = await library.material(ownerActor, String(args.materialId ?? ''));
    return { id: row.id, title: row.title, kind: row.kind, revision: row.revision, organizationRevision: row.organizationRevision, folderId: row.folderId, topicId: row.topicId, uri: row.uri, archived: Boolean(row.archivedAt), extraction: row.extraction, tags: row.tags, note: row.uri ? '保存的链接不是已经阅读过的网页内容。' : undefined };
  }
  const limit = pageLimit(args.limit, action === 'content' ? 8 : 20, action === 'content' ? 20 : 100);
  const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  if (action === 'content') {
    const revision = Number(args.revision);
    if (!Number.isInteger(revision) || revision < 1) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'content 需要资料版本', 400);
    const chunks = await library.content(ownerActor, String(args.materialId ?? ''), revision, cursor, limit);
    return { revision, items: chunks.items, total: chunks.total, truncated: chunks.nextCursor !== null, nextCursor: chunks.nextCursor === null ? null : String(chunks.nextCursor) };
  }
  if (action === 'list' || action === 'search') {
    const filters = { archived: libraryArchived(args.archived), ...(typeof args.folderId === 'string' ? { folderId: args.folderId } : {}) };
    const found = action === 'list' ? await library.materials(ownerActor, filters, cursor, limit) : await library.search(ownerActor, String(args.q ?? ''), filters, cursor, limit);
    return { items: found.items, total: found.total, hasMore: found.nextCursor !== null, nextCursor: found.nextCursor === null ? null : String(found.nextCursor) };
  }
  if (action === 'linked_tasks') {
    const rows = await library.materialTasks(ownerActor, String(args.materialId ?? ''), cursor, limit);
    return { items: rows.items, total: rows.total, hasMore: rows.nextCursor !== null, nextCursor: rows.nextCursor === null ? null : String(rows.nextCursor) };
  }
  const rows = await library.taskMaterials(ownerActor, String(args.taskId ?? ''), { archived: libraryArchived(args.archived) }, cursor, limit);
  return { items: rows.items, total: rows.total, hasMore: rows.nextCursor !== null, nextCursor: rows.nextCursor === null ? null : String(rows.nextCursor) };
}

function libraryArchived(value: unknown): 'exclude' | 'only' | 'include' | undefined {
  if (value === 'exclude' || value === 'only' || value === 'include') return value;
  return undefined;
}

function snippet(text: string, query: string) {
  const index = text.toLocaleLowerCase('en-US').indexOf(query.toLocaleLowerCase('en-US'));
  const start = Math.max(0, (index < 0 ? 0 : index) - 40);
  return text.slice(start, start + 160);
}

async function searchWorkspace(args: Record<string, unknown>, context: StoredChatContext) {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if ([...q].length < 1 || [...q].length > 200) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'q 需要 1～200 个字符', 400);
  const requested = Array.isArray(args.types) && args.types.length ? args.types.filter((item): item is 'task' | 'material' | 'memory' | 'conversation' => item === 'task' || item === 'material' || item === 'memory' || item === 'conversation') : ['task', 'material', 'memory', 'conversation'] as const;
  const scope = args.scope === undefined ? 'current' : args.scope;
  if (scope !== 'current' && scope !== 'all') throw new DomainError('INVALID_TOOL_ARGUMENTS', 'scope 只能是 current 或 all', 400);
  const limit = pageLimit(args.limit, 20, 50);
  const scopeKey = scope === 'all' ? 'all' : context.scope.kind === 'topic' ? `topic:${context.scope.topicId}` : context.scope.kind;
  const fingerprint = createHash('sha256').update(canonical({ q, requested, scopeKey, actor: ownerActor.id })).digest('hex');
  let decoded: { fingerprint?: string; offsets?: Record<string, number> } = {};
  if (args.cursor !== undefined) {
    try { decoded = JSON.parse(Buffer.from(String(args.cursor), 'base64url').toString('utf8')); }
    catch { throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409); }
    if (decoded.fingerprint !== fingerprint) throw new DomainError('CURSOR_STALE', '查询条件已变化，请从第一页重新读取', 409);
  }
  const topicId = context.scope.kind === 'topic' ? context.scope.topicId : null;
  const currentFilter = scope === 'all' ? {} : context.scope.kind === 'inbox' ? { topicId: null } : context.scope.kind === 'topic' ? { topicId } : {};
  const errors: Array<{ type: string; message: string }> = [];
  const buckets: Record<string, Array<Record<string, unknown>>> = { task: [], material: [], memory: [], conversation: [] };
  const offsets = decoded.offsets ?? {};
  const take = async (type: string, load: () => Promise<Array<Record<string, unknown>>>) => {
    if (!requested.includes(type as 'task')) return;
    try {
      const rows = await load();
      buckets[type] = rows;
    } catch (error) {
      errors.push({ type, message: error instanceof Error ? error.message : '读取失败' });
    }
  };
  await take('task', async () => (await prisma.task.findMany({ where: { ...currentFilter, deletedAt: null, OR: [{ title: { contains: q } }, { description: { contains: q } }] }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200, select: { id: true, title: true, description: true, revision: true, updatedAt: true, topicId: true } })).map((row) => ({ type: 'task', id: row.id, title: row.title, snippet: snippet(`${row.title}\n${row.description}`, q), locator: { topicId: row.topicId }, revision: row.revision, at: row.updatedAt })));
  await take('material', async () => {
    const rows = await prisma.material.findMany({ where: { ...currentFilter, archivedAt: null }, include: { versions: { orderBy: { revision: 'desc' }, take: 1 } }, take: 200 });
    return rows.flatMap((row) => {
      const version = row.versions[0];
      const body = `${row.title}\n${version?.content ?? ''}`;
      if (!body.toLocaleLowerCase('en-US').includes(q.toLocaleLowerCase('en-US'))) return [];
      return [{ type: 'material', id: row.id, title: row.title, snippet: snippet(body, q), locator: { topicId: row.topicId, revision: row.revision }, revision: row.revision, at: row.updatedAt }];
    });
  });
  await take('memory', async () => {
    const where = scope === 'all' ? { status: 'active' } : context.scope.kind === 'topic' ? { status: 'active', OR: [{ topicId }, { topicId: null }] } : { status: 'active', topicId: null };
    const rows = await prisma.memory.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200 });
    return rows.flatMap((row) => {
      const body = `${row.title}\n${row.content}`;
      if (!body.toLocaleLowerCase('en-US').includes(q.toLocaleLowerCase('en-US'))) return [];
      return [{ type: 'memory', id: row.id, title: row.title, snippet: snippet(body, q), locator: { topicId: row.topicId }, scopeLabel: row.topicId === null && context.scope.kind === 'topic' ? '收集箱' : undefined, revision: row.revision, at: row.updatedAt }];
    });
  });
  await take('conversation', async () => {
    const turns = await prisma.autoMemoryTurn.findMany({ where: scope === 'all' ? {} : { topicId: context.scope.kind === 'topic' ? topicId : null }, select: { userMessageId: true, assistantMessageIds: true, topicId: true } });
    const ids = turns.flatMap((turn) => {
      let assistants: string[] = [];
      try { assistants = JSON.parse(turn.assistantMessageIds) as string[]; } catch { assistants = []; }
      return [turn.userMessageId, ...assistants];
    });
    if (!ids.length) return [];
    const rows = await prisma.message.findMany({ where: { id: { in: ids }, content: { contains: q }, role: { in: ['user', 'assistant'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, select: { id: true, conversationId: true, content: true, createdAt: true, role: true } });
    return rows.map((row) => ({ type: 'conversation', id: row.id, title: row.role === 'user' ? '你的消息' : '助手消息', snippet: snippet(row.content, q), locator: { conversationId: row.conversationId, messageId: row.id }, at: row.createdAt }));
  });
  const order = ['task', 'material', 'memory', 'conversation'];
  const positions = Object.fromEntries(order.map((type) => [type, offsets[type] ?? 0])) as Record<string, number>;
  const items: Record<string, unknown>[] = [];
  while (items.length < limit) {
    let progressed = false;
    for (const type of order) {
      const row = buckets[type]?.[positions[type] ?? 0];
      if (!row) continue;
      positions[type] = (positions[type] ?? 0) + 1;
      items.push(row);
      progressed = true;
      if (items.length >= limit) break;
    }
    if (!progressed) break;
  }
  const hasMore = order.some((type) => (buckets[type]?.length ?? 0) > (positions[type] ?? 0));
  return { items, errors, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ fingerprint, offsets: positions })).toString('base64url') : null, scope: scopeKey };
}

async function memoryRead(args: Record<string, unknown>, context: StoredChatContext) {
  const invalid = validateMemoryArguments({ ...args, action: args.action });
  if (invalid) throw new DomainError('INVALID_TOOL_ARGUMENTS', invalid, 400);
  const topicId = args.target === 'inbox' || context.scope.kind !== 'topic' ? null : context.scope.topicId;
  return runAgentMemoryTool({ name: 'memory', arguments: args }, { topicId });
}

export async function executeBuiltinTool(input: {
  name: string;
  args: Record<string, unknown>;
  context: StoredChatContext;
  run: { id: string; leaseToken: string; conversationId: string; assistantMessageId: string; sourceUserMessageId: string };
  toolCallId: string;
  clock?: Clock;
}): Promise<BuiltinResult> {
  try {
    if (!isBuiltinTool(input.name)) return CAPABILITY_UNAVAILABLE;
    const args = input.args;
    if (input.name === 'get_time') {
      if (Object.keys(args).some((key) => key !== 'timeZone')) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'get_time 只接受 timeZone', 400);
      return { success: true, data: getCurrentTime({ timeZone: typeof args.timeZone === 'string' ? args.timeZone : undefined }, input.context, input.clock) };
    }
    if (input.name === 'get_work_context') return { success: true, data: { scope: input.context.scope, page: input.context.page, taskId: input.context.taskId, materialId: input.context.materialId, timeZone: input.context.timeZone, timeZoneSource: input.context.timeZoneSource, note: '固定说明、简报和记忆已在系统消息中。需要全文时继续用工具读取。' } };
    if (input.name === 'query_tasks') return { success: true, data: redact(await queryTasks(args, input.context)) };
    if (input.name === 'query_topics') return { success: true, data: redact(await queryTopics(args)) };
    if (input.name === 'get_task_activity') {
      return { success: true, data: await queryTaskActivity(ownerActor, { taskId: String(args.taskId ?? ''), from: args.from === undefined ? undefined : args.from as string | null, to: typeof args.to === 'string' ? args.to : undefined, actors: Array.isArray(args.actors) ? args.actors as Array<'user' | 'agent' | 'unknown'> : undefined, fields: Array.isArray(args.fields) ? args.fields as never : undefined, cursor: typeof args.cursor === 'string' ? args.cursor : undefined, limit: args.limit === undefined ? undefined : Number(args.limit) }, input.clock) };
    }
    if (input.name === 'search_workspace') return { success: true, data: redact(await searchWorkspace(args, input.context)) };
    if (input.name === 'library_read') return { success: true, data: redact(await libraryRead(args)) };
    if (input.name === 'memory_read') return redact(await memoryRead(args, input.context)) as BuiltinResult;
    if (input.name === 'conversation_search') {
      const invalid = validateConversationSearchArguments(args);
      if (invalid) throw new DomainError('INVALID_TOOL_ARGUMENTS', invalid, 400);
      const topicId = input.context.scope.kind === 'topic' ? input.context.scope.topicId : null;
      return redact(await runAgentMemoryTool({ name: 'conversation_search', arguments: args }, { conversationId: input.run.conversationId, topicId })) as BuiltinResult;
    }
    if (input.name === 'get_change_schema') {
      const family = args.family;
      if (family !== 'workspace' && family !== 'library' && family !== 'memory') throw new DomainError('INVALID_TOOL_ARGUMENTS', 'family 无效', 400);
      return { success: true, data: changeSchemaDocument(family, typeof args.kind === 'string' ? args.kind : undefined) };
    }
    if (input.name === 'prepare_external_prompt') {
      const parsed = externalPromptInput.parse(args);
      const prompt = renderExternalPrompt(parsed);
      const part = externalPromptPart(input.run.assistantMessageId, input.toolCallId, parsed, prompt);
      const row = await prisma.message.findUnique({ where: { id: input.run.assistantMessageId }, select: { partsJson: true } });
      const parts = JSON.parse(row?.partsJson || '[]') as unknown[];
      if (!parts.some((item) => item && typeof item === 'object' && (item as { id?: string }).id === part.id)) parts.push(part);
      await prisma.message.update({ where: { id: input.run.assistantMessageId }, data: { partsJson: JSON.stringify(parts) } });
      return { success: true, data: { status: 'ready', partId: part.id, title: part.title, limitation: part.limitation }, part };
    }
    if (input.name === 'propose_changes') {
      const prepared = await prepareChanges({ runId: input.run.id, leaseToken: input.run.leaseToken, conversationId: input.run.conversationId, assistantMessageId: input.run.assistantMessageId, sourceUserMessageId: input.run.sourceUserMessageId, toolCallId: input.toolCallId, topicId: input.context.scope.kind === 'topic' ? input.context.scope.topicId : null, args });
      return { ...prepared, approval: prepared.success === true };
    }
    return CAPABILITY_UNAVAILABLE;
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'LEASE_LOST' || error.code === 'RUN_SUPERSEDED')) throw error;
    return fail(error);
  }
}
