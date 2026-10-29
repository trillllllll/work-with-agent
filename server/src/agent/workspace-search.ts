import { createHash } from 'node:crypto';
import { versionProjection } from '../application/resources/version.js';
import { DomainError } from '../domain/task.js';
import { canonical } from '../application/commands.js';
import { ownerActor } from '../application/security.js';
import { prisma } from '../infrastructure/prisma.js';
import type { StoredChatContext } from './chat-context.js';

export const SEARCH_SOURCES = ['task', 'material', 'memory', 'conversation'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];
export const SEARCH_BATCH = 200;

export type SearchBatch = { rows: Array<Record<string, unknown> & { id: string }>; done: boolean };
type CursorState = { version: 2; fingerprint: string; positions: Record<SearchSource, string | null>; next: SearchSource };

function textIncludes(text: string, query: string) {
  return text.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US'));
}

function snippet(text: string, query: string) {
  const index = text.toLocaleLowerCase('en-US').indexOf(query.toLocaleLowerCase('en-US'));
  const start = Math.max(0, (index < 0 ? 0 : index) - 40);
  return text.slice(start, start + 160);
}

function fingerprintOf(q: string, requested: SearchSource[], scopeKey: string, actorId: string) {
  return createHash('sha256').update(canonical({ q, requested: [...requested].sort(), scopeKey, actor: actorId })).digest('hex');
}

function decodeCursor(cursor: string | undefined, fingerprint: string, requested: SearchSource[]): { positions: Record<SearchSource, string | null>; next: SearchSource } {
  const empty = { positions: { task: null, material: null, memory: null, conversation: null } as Record<SearchSource, string | null>, next: requested[0] ?? 'task' };
  if (!cursor) return empty;
  let parsed: Partial<CursorState> | null = null;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorState>; }
  catch { throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409); }
  if (!parsed || parsed.version !== 2) throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  if (parsed.fingerprint !== fingerprint) throw new DomainError('CURSOR_STALE', '查询条件已变化，请从第一页重新读取', 409);
  if (!parsed.next || !requested.includes(parsed.next) || !parsed.positions) throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  const positions = { task: null, material: null, memory: null, conversation: null } as Record<SearchSource, string | null>;
  for (const source of SEARCH_SOURCES) {
    const value = parsed.positions[source];
    if (value !== null && value !== undefined && typeof value !== 'string') throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
    positions[source] = typeof value === 'string' ? value : null;
  }
  return { positions, next: parsed.next };
}

export async function walkSearch(input: {
  fingerprint: string;
  requested: SearchSource[];
  limit: number;
  cursor?: string;
  read: (source: SearchSource, afterId: string | null) => Promise<SearchBatch>;
  match: (source: SearchSource, row: SearchBatch['rows'][number]) => boolean;
}) {
  const requested = SEARCH_SOURCES.filter((source) => input.requested.includes(source));
  const decoded = decodeCursor(input.cursor, input.fingerprint, requested);
  const positions = { ...decoded.positions };
  const staged = new Map<SearchSource, SearchBatch['rows'][number]>();
  const done = new Set<SearchSource>();
  const failed = new Set<SearchSource>();
  const errors: Array<{ type: string; message: string }> = [];
  const nextOf = (source: SearchSource) => {
    const index = requested.indexOf(source);
    return requested[(index + 1) % requested.length] ?? source;
  };
  const stageOne = async (source: SearchSource) => {
    if (staged.has(source) || done.has(source) || failed.has(source)) return;
    let after = positions[source];
    for (;;) {
      let batch: SearchBatch;
      try { batch = await input.read(source, after); }
      catch (error) {
        failed.add(source);
        errors.push({ type: source, message: error instanceof Error ? error.message : '读取失败' });
        return;
      }
      if (!batch.rows.length) { done.add(source); positions[source] = after; return; }
      let matched: SearchBatch['rows'][number] | null = null;
      let lastNonMatch: string | null = null;
      for (const row of batch.rows) {
        if (input.match(source, row)) { matched = row; break; }
        lastNonMatch = row.id;
      }
      if (lastNonMatch) positions[source] = lastNonMatch;
      if (matched) { staged.set(source, matched); return; }
      after = batch.rows[batch.rows.length - 1]?.id ?? after;
      positions[source] = after;
      if (batch.done || batch.rows.length < SEARCH_BATCH) { done.add(source); return; }
    }
  };
  const items: Array<Record<string, unknown>> = [];
  let turn = decoded.next;
  while (items.length < input.limit && requested.length) {
    await stageOne(turn);
    if (!staged.has(turn)) {
      const start = turn;
      let found = false;
      do {
        turn = nextOf(turn);
        if (turn === start) break;
        await stageOne(turn);
        if (staged.has(turn)) { found = true; break; }
      } while (true);
      if (!found) break;
    }
    const row = staged.get(turn);
    if (!row) break;
    staged.delete(turn);
    positions[turn] = row.id;
    items.push(row);
    turn = nextOf(turn);
  }
  for (const source of requested) await stageOne(source);
  const complete = requested.every((source) => done.has(source) && !staged.has(source) && !failed.has(source));
  const partial = requested.some((source) => failed.has(source));
  const hasMore = !complete;
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ version: 2, fingerprint: input.fingerprint, positions, next: turn } satisfies CursorState)).toString('base64url') : null;
  return { items, errors, hasMore, nextCursor, partial };
}

function scopeGlobal(scope: 'current' | 'all', context: StoredChatContext) {
  return scope === 'all' || context.scope.kind === 'all';
}

export async function searchWorkspace(args: Record<string, unknown>, context: StoredChatContext) {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if ([...q].length < 1 || [...q].length > 200) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'q 需要 1～200 个字符', 400);
  const requested = Array.isArray(args.types) && args.types.length
    ? args.types.filter((item): item is SearchSource => item === 'task' || item === 'material' || item === 'memory' || item === 'conversation')
    : [...SEARCH_SOURCES];
  if (Array.isArray(args.types) && args.types.some((item) => item !== 'task' && item !== 'material' && item !== 'memory' && item !== 'conversation')) {
    throw new DomainError('INVALID_TOOL_ARGUMENTS', 'types 只能包含 task、material、memory、conversation', 400);
  }
  if (!requested.length) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'types 至少选择一个来源', 400);
  const scope = args.scope === undefined ? 'current' : args.scope;
  if (scope !== 'current' && scope !== 'all') throw new DomainError('INVALID_TOOL_ARGUMENTS', 'scope 只能是 current 或 all', 400);
  const limitValue = args.limit === undefined ? 20 : Number(args.limit);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 50) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'limit 需要是 1 到 50 的整数', 400);
  const topicId = context.scope.kind === 'topic' ? context.scope.topicId : null;
  const global = scopeGlobal(scope, context);
  const scopeKey = scope === 'all' || context.scope.kind === 'all' ? 'all' : context.scope.kind === 'topic' ? `topic:${topicId}` : context.scope.kind;
  const taskFilter = global ? { deletedAt: null } : context.scope.kind === 'topic' ? { deletedAt: null, topicId } : { deletedAt: null, topicId: null };
  const materialFilter = global ? { archivedAt: null } : context.scope.kind === 'topic' ? { archivedAt: null, topicId } : { archivedAt: null, topicId: null };
  const memoryWhere = global ? { status: 'active' } : context.scope.kind === 'topic' ? { status: 'active', OR: [{ topicId }, { topicId: null }] } : { status: 'active', topicId: null };
  const turnWhere = global ? {} : { topicId: context.scope.kind === 'topic' ? topicId : null };
  const fingerprint = fingerprintOf(q, requested, scopeKey, ownerActor.id);
  const read = async (source: SearchSource, afterId: string | null): Promise<SearchBatch> => {
    const after = afterId ? { id: { gt: afterId } } : {};
    if (source === 'task') {
      const rows = await prisma.task.findMany({ where: { ...taskFilter, ...after }, orderBy: { id: 'asc' }, take: SEARCH_BATCH, select: { id: true, title: true, description: true, revision: true, updatedAt: true, topicId: true } });
      return { rows: rows.map((row) => ({ ...row, searchType: source })), done: rows.length < SEARCH_BATCH };
    }
    if (source === 'material') {
      const rows = await prisma.material.findMany({ where: { ...materialFilter, ...after, sourceTaskId: null }, orderBy: { id: 'asc' }, take: SEARCH_BATCH, include: { versions: { orderBy: { revision: 'desc' }, take: 1 } } });
      return { rows: rows.map((row) => ({ ...row, searchType: source, body: `${row.title}\n${row.versions[0] ? versionProjection(row.kind, row.versions[0]) : ''}` })), done: rows.length < SEARCH_BATCH };
    }
    if (source === 'memory') {
      const rows = await prisma.memory.findMany({ where: { ...memoryWhere, ...after }, orderBy: { id: 'asc' }, take: SEARCH_BATCH });
      return { rows: rows.map((row) => ({ ...row, searchType: source })), done: rows.length < SEARCH_BATCH };
    }
    const turns = await prisma.autoMemoryTurn.findMany({ where: turnWhere, select: { userMessageId: true, assistantMessageIds: true } });
    const ids = turns.flatMap((turn) => {
      let assistants: string[] = [];
      try { assistants = JSON.parse(turn.assistantMessageIds) as string[]; } catch { assistants = []; }
      return [turn.userMessageId, ...assistants];
    });
    if (!ids.length) return { rows: [], done: true };
    const rows = await prisma.message.findMany({ where: { id: { in: ids, ...(afterId ? { gt: afterId } : {}) }, role: { in: ['user', 'assistant'] } }, orderBy: { id: 'asc' }, take: SEARCH_BATCH, select: { id: true, conversationId: true, content: true, createdAt: true, role: true } });
    return { rows: rows.map((row) => ({ ...row, searchType: source })), done: rows.length < SEARCH_BATCH };
  };
  const match = (source: SearchSource, row: SearchBatch['rows'][number]) => {
    if (source === 'task') return textIncludes(`${row.title ?? ''}\n${row.description ?? ''}`, q);
    if (source === 'material') return textIncludes(String(row.body ?? ''), q);
    if (source === 'memory') return textIncludes(`${row.title ?? ''}\n${row.content ?? ''}`, q);
    return textIncludes(String(row.content ?? ''), q);
  };
  const page = await walkSearch({ fingerprint, requested, limit: limitValue, cursor: typeof args.cursor === 'string' ? args.cursor : undefined, read, match });
  return {
    ...page,
    items: page.items.map((row) => {
      if (row.searchType === 'task') return { type: 'task', id: row.id, title: row.title, snippet: snippet(`${row.title}\n${row.description}`, q), locator: { topicId: row.topicId }, revision: row.revision, at: row.updatedAt };
      if (row.searchType === 'material') return { type: 'material', id: row.id, title: row.title, snippet: snippet(String(row.body ?? ''), q), locator: { topicId: row.topicId, revision: row.revision }, revision: row.revision, at: row.updatedAt };
      if (row.searchType === 'memory') return { type: 'memory', id: row.id, title: row.title, snippet: snippet(`${row.title}\n${row.content}`, q), locator: { topicId: row.topicId }, ...(row.topicId === null && context.scope.kind === 'topic' ? { scopeLabel: '收集箱' } : {}), revision: row.revision, at: row.updatedAt };
      return { type: 'conversation', id: row.id, title: row.role === 'user' ? '你的消息' : '助手消息', snippet: snippet(String(row.content ?? ''), q), locator: { conversationId: row.conversationId, messageId: row.id }, at: row.createdAt };
    }),
    scope: scopeKey,
  };
}
