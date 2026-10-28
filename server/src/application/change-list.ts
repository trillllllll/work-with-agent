import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { hasUndoHandler, undoHandlerTypes } from './undo-handler-names.js';

const TASK_OPS = ['create', 'update', 'delete', 'restore', 'reorder'];
const TOPIC_OPS = ['create', 'update', 'delete', 'archive', 'archive_preserve', 'restore', 'move_tasks_to_inbox', 'confirm_summary', 'discard_summary'];
const TAG_OPS = ['create', 'update', 'delete'];
const UPDATE_OPS = ['update', 'reorder', 'move_tasks_to_inbox'];
const DELETE_OPS = ['delete', 'archive', 'archive_preserve', 'permanent_delete'];
const SUMMARY_OPS = ['confirm_summary', 'discard_summary'];
const NAMED_OPS = ['create', ...UPDATE_OPS, ...DELETE_OPS, 'restore', ...SUMMARY_OPS, 'execute'];
const OP_GROUPS = ['create', 'update', 'delete', 'restore', 'summary', 'execute', 'undo', 'other'] as const;
const STATUSES = ['reversible', 'undone', 'blocked'] as const;
const DELETE_NAME_OPS = new Set(DELETE_OPS);
const ID_LIKE = /^[A-Za-z0-9_-]{16,64}$/;
const FIELD_PRIORITY: Record<string, string[]> = {
  task: ['title', 'status', 'priority', 'dueDate', 'scheduledStart', 'topicId', 'parentId', 'description', 'tagIds', 'recurrenceRule', 'reminderMinutesBefore'],
  topic: ['name', 'description', 'color', 'goal', 'goalDueDate', 'draftSummary', 'finalSummary', 'archivedAt'],
  tag: ['name', 'color'],
};
const OTHER_FIELDS = ['title', 'name', 'enabled', 'status', 'archivedAt'];
/** Bookkeeping keys omitted before a field diff. A later stats feature will add `completedAt` and `completedAtEstimated`. */
// completedAt follows status; it is derived bookkeeping, not a separate edit.
export const DIFF_IGNORED_FIELDS = ['updatedAt', 'revision', 'createdAt', 'completedAt', 'completedAtEstimated'] as const;

export type OpGroup = (typeof OP_GROUPS)[number];
export type ChangeStatus = (typeof STATUSES)[number];
export type BlockCode = 'CHANGE_ALREADY_UNDONE' | 'CHANGE_NOT_REVERSIBLE' | 'MISSING_SNAPSHOT';
export type BlockKind = 'already_undone' | 'undo_record' | 'execution' | 'permanent_delete' | 'unsupported' | 'missing_snapshot';
export type UndoBlockedReason = { code: BlockCode; reason: BlockKind };
export type ChangeSummary = { field: string; before: string; after: string } | { kind: 'tool'; toolName: string; success: boolean };
export type ChangeListFilter = {
  type?: string[];
  op?: OpGroup[];
  source?: string[];
  status?: ChangeStatus[];
  from?: string;
  q?: string;
  /** Exact id, kept so existing `?entityId=` callers still hit one object. */
  entityId?: string;
};
export type ChangeListItem = {
  id: string;
  entityType: string;
  entityId: string;
  operation: string;
  entityName: string;
  groupCount: number;
  changeSummary: ChangeSummary | null;
  source: string;
  actorKind: 'user' | 'assistant' | 'connection';
  connectionId: string | null;
  connectionName: string | null;
  approvalId: string | null;
  canUndo: boolean;
  undoBlockedReason: UndoBlockedReason | null;
  undoneAt: string | null;
  createdAt: string;
};
export type ChangePage = {
  items: ChangeListItem[];
  nextCursor: string | null;
  total: number;
  connections?: { id: string; name: string | null }[];
};

type ChangeRow = {
  id: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  operation: string;
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
  source: string;
  connectionId: string | null;
  approvalId: string | null;
  undoneAt: string | null;
  createdAt: string;
};

const invalidFilter = () => new DomainError('VALIDATION_ERROR', '筛选参数无效', 400);
const invalidCursor = () => new DomainError('INVALID_CURSOR', '分页游标无效', 400);

/** Same stable encoding as `canonical` in commands.ts. Kept local to avoid an import cycle. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return queryString(value[0]);
  return undefined;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function reversibleOp(entityType: string, operation: string) {
  if (operation.startsWith('undo:')) return false;
  if ((entityType === 'workspace' || entityType === 'proposal') && operation === 'batch') return true;
  if (hasUndoHandler(entityType)) return true;
  if (entityType === 'task') return TASK_OPS.includes(operation);
  if (entityType === 'topic') return TOPIC_OPS.includes(operation);
  if (entityType === 'tag') return TAG_OPS.includes(operation);
  return false;
}

/** A snapshot counts when at least one side is a non-empty string. Creates and deletes qualify. */
export function hasChangeSnapshot(record: { beforeSnapshot: string | null; afterSnapshot: string | null }) {
  return Boolean(record.beforeSnapshot) || Boolean(record.afterSnapshot);
}

export function blockReason(record: { undoneAt: string | null; entityType: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }): UndoBlockedReason | null {
  if (record.undoneAt) return { code: 'CHANGE_ALREADY_UNDONE', reason: 'already_undone' };
  if (record.operation.startsWith('undo:')) return { code: 'CHANGE_NOT_REVERSIBLE', reason: 'undo_record' };
  if (record.entityType === 'execution') return { code: 'CHANGE_NOT_REVERSIBLE', reason: 'execution' };
  if (record.operation === 'permanent_delete') return { code: 'CHANGE_NOT_REVERSIBLE', reason: 'permanent_delete' };
  if (!reversibleOp(record.entityType, record.operation)) return { code: 'CHANGE_NOT_REVERSIBLE', reason: 'unsupported' };
  if (!hasChangeSnapshot(record)) return { code: 'MISSING_SNAPSHOT', reason: 'missing_snapshot' };
  return null;
}

/** The literals stay inside `DomainError` so the i18n check sees the same strings `undo()` returns. */
export function blockedChangeError(blocked: UndoBlockedReason) {
  switch (blocked.reason) {
    case 'already_undone': return new DomainError(blocked.code, '该变更已经撤销', 400);
    case 'undo_record': return new DomainError(blocked.code, '这是一条撤销记录，不能再撤销', 400);
    case 'execution': return new DomainError(blocked.code, '受控执行记录不可撤销', 400);
    case 'permanent_delete': return new DomainError(blocked.code, '此类操作不支持撤销（永久删除）', 400);
    case 'unsupported': return new DomainError(blocked.code, '该变更不可撤销', 400);
    case 'missing_snapshot': return new DomainError(blocked.code, '缺少变更前后的快照，无法撤销', 400);
  }
}

export function blockReasonMessage(reason: BlockKind) {
  return blockedChangeError({ code: 'CHANGE_NOT_REVERSIBLE', reason }).message;
}

export function changeStatus(record: { undoneAt: string | null; entityType: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }): ChangeStatus {
  const reason = blockReason(record);
  if (!reason) return 'reversible';
  if (reason.code === 'CHANGE_ALREADY_UNDONE') return 'undone';
  return 'blocked';
}

/** connection wins; anything that is not a user and has no connection is the assistant, including values such as `mcp`. */
export function actorKindOf(source: string, connectionId: string | null): ChangeListItem['actorKind'] {
  if (connectionId) return 'connection';
  if (source === 'user') return 'user';
  return 'assistant';
}

function parseSnapshot(value: unknown): any {
  if (typeof value !== 'string') return value ?? null;
  const text = value.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function textOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function objectName(value: Record<string, unknown>) {
  for (const key of ['title', 'name', 'toolName', 'finalSummary', 'draftSummary']) {
    const text = textOf(value[key]);
    if (text) return text;
  }
  return '';
}

function groupKey(entityType: string) {
  if (entityType === 'task') return 'tasks';
  if (entityType === 'topic') return 'topics';
  if (entityType === 'tag') return 'tags';
  return null;
}

function readDisplayName(entityType: string, entityId: string, raw: unknown, depth = 0): string {
  if (depth > 4) return '';
  const value = parseSnapshot(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.version === 2 && value.entities) {
    const key = groupKey(entityType);
    const direct = key ? value.entities[key]?.[entityId] : null;
    if (direct && typeof direct === 'object') {
      const named = objectName(direct as Record<string, unknown>);
      if (named) return named;
    }
    for (const map of [value.entities.tasks, value.entities.topics, value.entities.tags]) {
      if (!map || typeof map !== 'object') continue;
      for (const entity of Object.values(map)) {
        if (entity && typeof entity === 'object') {
          const named = objectName(entity as Record<string, unknown>);
          if (named) return named;
        }
      }
    }
    return '';
  }
  if (value.version === 3 && Array.isArray(value.changes)) {
    const match = value.changes.find((item: any) => item?.entityType === entityType && item?.entityId === entityId);
    if (match) {
      const named = readDisplayName(match.entityType, match.entityId, match.snapshot, depth + 1);
      if (named) return named;
    }
    for (const item of value.changes) {
      if (!item || typeof item !== 'object') continue;
      const named = readDisplayName(item.entityType, item.entityId, item.snapshot, depth + 1);
      if (named) return named;
    }
    return '';
  }
  return objectName(value as Record<string, unknown>);
}

/** Deletes keep the previous name. Every other write uses the resulting snapshot, then falls back. */
export function changeDisplayName(entityType: string, entityId: string, before: unknown, after: unknown, operation = '') {
  const primary = DELETE_NAME_OPS.has(operation) ? before : after;
  const secondary = primary === before ? after : before;
  return readDisplayName(entityType, entityId, primary) || readDisplayName(entityType, entityId, secondary) || '';
}

/** Batch rows name only themselves. A real rename rewrites that object's history in the same transaction. */
export async function syncEntityName(tx: Prisma.TransactionClient, entityType: string, entityId: string, operation: string, entityName: string) {
  if (!entityName || operation === 'batch' || operation === 'undo:batch') return;
  await tx.changeRecord.updateMany({ where: { entityType, entityId }, data: { entityName } });
}

function clip(value: unknown) {
  const text = value == null ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) ?? '';
  const chars = Array.from(text);
  return chars.length > 80 ? chars.slice(0, 80).join('') : text;
}

function subjectObject(entityType: string, entityId: string, raw: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  const value = parseSnapshot(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version === 2 && value.entities) {
    const key = groupKey(entityType);
    const direct = key ? value.entities[key]?.[entityId] : null;
    return direct && typeof direct === 'object' ? direct as Record<string, unknown> : null;
  }
  if (value.version === 3 && Array.isArray(value.changes)) {
    const match = value.changes.find((item: any) => item?.entityType === entityType && item?.entityId === entityId) ?? value.changes[0];
    return match ? subjectObject(String(match.entityType ?? entityType), String(match.entityId ?? entityId), match.snapshot, depth + 1) : null;
  }
  return value as Record<string, unknown>;
}

function countEntities(raw: unknown, depth = 0): number {
  if (depth > 4) return 0;
  const value = parseSnapshot(raw);
  if (!value || typeof value !== 'object') return 0;
  if (value.version === 2 && value.entities) {
    return ['tasks', 'topics', 'tags'].reduce((sum, key) => sum + Object.keys(value.entities[key] ?? {}).length, 0);
  }
  if (value.version === 3 && Array.isArray(value.changes)) return value.changes.length;
  return 1;
}

function groupCount(before: string | null, after: string | null) {
  return Math.max(countEntities(before), countEntities(after), 1);
}

function toolSummary(raw: unknown): ChangeSummary | null {
  const value = parseSnapshot(raw);
  if (!value || typeof value !== 'object' || typeof value.toolName !== 'string' || !value.toolName) return null;
  const result = value.result;
  const success = Boolean(result && typeof result === 'object' && 'success' in result ? result.success : result);
  return { kind: 'tool', toolName: value.toolName, success };
}

function withoutIgnored(value: Record<string, unknown> | null) {
  if (!value) return null;
  const next: Record<string, unknown> = { ...value };
  for (const key of DIFF_IGNORED_FIELDS) delete next[key];
  return next;
}

function fieldSummary(record: ChangeRow): ChangeSummary | null {
  if (!UPDATE_OPS.includes(record.operation)) return null;
  const before = withoutIgnored(subjectObject(record.entityType, record.entityId, record.beforeSnapshot));
  const after = withoutIgnored(subjectObject(record.entityType, record.entityId, record.afterSnapshot));
  if (!before && !after) return null;
  const both = Boolean(before) && Boolean(after);
  const priority = FIELD_PRIORITY[record.entityType] ?? OTHER_FIELDS;
  const rest = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((field) => !priority.includes(field))
    .sort((left, right) => left.localeCompare(right));
  for (const field of [...priority, ...rest]) {
    // A key that exists on only one snapshot is a schema addition, not an edit. An explicit null is a value.
    if (both && (!(field in before!) || !(field in after!))) continue;
    const left = before?.[field];
    const right = after?.[field];
    if (JSON.stringify(left ?? null) === JSON.stringify(right ?? null)) continue;
    return { field, before: clip(left), after: clip(right) };
  }
  return null;
}

function changeSummary(record: ChangeRow): ChangeSummary | null {
  if (record.entityType === 'execution' || record.operation === 'execute') return toolSummary(record.afterSnapshot) ?? toolSummary(record.beforeSnapshot);
  return fieldSummary(record);
}

function opWhere(group: OpGroup): Prisma.ChangeRecordWhereInput {
  switch (group) {
    case 'create': return { operation: 'create' };
    case 'update': return { operation: { in: UPDATE_OPS } };
    case 'delete': return { operation: { in: DELETE_OPS } };
    case 'restore': return { operation: 'restore' };
    case 'summary': return { operation: { in: SUMMARY_OPS } };
    case 'execute': return { operation: 'execute' };
    case 'undo': return { operation: { startsWith: 'undo:' } };
    case 'other': return { NOT: { OR: [{ operation: { in: NAMED_OPS } }, { operation: { startsWith: 'undo:' } }] } };
  }
}

function reversibleOpWhere(): Prisma.ChangeRecordWhereInput {
  const handlers = undoHandlerTypes();
  const or: Prisma.ChangeRecordWhereInput[] = [
    { entityType: 'workspace', operation: 'batch' },
    { entityType: 'proposal', operation: 'batch' },
    { entityType: 'task', operation: { in: TASK_OPS } },
    { entityType: 'topic', operation: { in: TOPIC_OPS } },
    { entityType: 'tag', operation: { in: TAG_OPS } },
  ];
  if (handlers.length) or.push({ entityType: { in: handlers } });
  return { NOT: { operation: { startsWith: 'undo:' } }, OR: or };
}

function nonemptySnapshot(field: 'beforeSnapshot' | 'afterSnapshot'): Prisma.ChangeRecordWhereInput {
  // `<> ''` is unknown when the column is NULL, which would drop the row from both status buckets.
  return { AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] };
}

function snapshotWhere(): Prisma.ChangeRecordWhereInput {
  return { OR: [nonemptySnapshot('beforeSnapshot'), nonemptySnapshot('afterSnapshot')] };
}

/** Mirrors `blockReason`: undone first, then undo rows, executions, permanent deletes, other irreversible ops, then missing snapshots. */
function canUndoWhere(): Prisma.ChangeRecordWhereInput {
  return {
    AND: [
      { undoneAt: null },
      { NOT: { entityType: 'execution' } },
      { NOT: { operation: 'permanent_delete' } },
      { NOT: { operation: { startsWith: 'undo:' } } },
      reversibleOpWhere(),
      snapshotWhere(),
    ],
  };
}

function statusWhere(status: ChangeStatus): Prisma.ChangeRecordWhereInput {
  if (status === 'undone') return { undoneAt: { not: null } };
  if (status === 'reversible') return canUndoWhere();
  return { AND: [{ undoneAt: null }, { NOT: canUndoWhere() }] };
}

function sourceWhere(token: string): Prisma.ChangeRecordWhereInput {
  if (token === 'user') return { source: 'user', connectionId: null };
  if (token === 'assistant') return { NOT: { source: 'user' }, connectionId: null };
  return { connectionId: token.slice(2) };
}

export function changeListWhere(filter: ChangeListFilter): Prisma.ChangeRecordWhereInput {
  const parts: Prisma.ChangeRecordWhereInput[] = [];
  if (filter.type?.length) parts.push({ entityType: { in: filter.type } });
  if (filter.entityId) parts.push({ entityId: filter.entityId });
  if (filter.op?.length) parts.push({ OR: filter.op.map(opWhere) });
  if (filter.source?.length) parts.push({ OR: filter.source.map(sourceWhere) });
  if (filter.status?.length) parts.push({ OR: filter.status.map(statusWhere) });
  if (filter.from) parts.push({ createdAt: { gte: filter.from } });
  if (filter.q) {
    const name: Prisma.ChangeRecordWhereInput = { entityName: { contains: filter.q } };
    parts.push(ID_LIKE.test(filter.q) ? { OR: [name, { entityId: filter.q }] } : name);
  }
  if (!parts.length) return {};
  if (parts.length === 1) return parts[0]!;
  return { AND: parts };
}

function parseTokenList(raw: string | undefined, accept: (token: string) => boolean, strict: boolean) {
  if (!raw?.trim()) return undefined;
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  const accepted: string[] = [];
  for (const token of tokens) {
    if (!accept(token)) {
      if (strict) throw invalidFilter();
      continue;
    }
    accepted.push(token);
  }
  return accepted.length ? uniqueSorted(accepted) : undefined;
}

function parseSourceToken(token: string) {
  if (token === 'user' || token === 'assistant') return true;
  return token.startsWith('c:') && token.length > 2;
}

function buildFilter(input: { type?: string; op?: string; source?: string; status?: string; from?: string; q?: string; entityId?: string }, strict: boolean): ChangeListFilter {
  const filter: ChangeListFilter = {};
  const type = parseTokenList(input.type, () => true, strict);
  if (type) filter.type = type;
  const op = parseTokenList(input.op, (token) => (OP_GROUPS as readonly string[]).includes(token), strict);
  if (op) filter.op = op as OpGroup[];
  const source = parseTokenList(input.source, parseSourceToken, strict);
  if (source) filter.source = source;
  const status = parseTokenList(input.status, (token) => (STATUSES as readonly string[]).includes(token), strict);
  if (status) filter.status = status as ChangeStatus[];
  if (input.from?.trim()) {
    const parsed = Date.parse(input.from.trim());
    if (Number.isNaN(parsed)) {
      if (strict) throw invalidFilter();
    } else filter.from = new Date(parsed).toISOString();
  }
  if (input.q !== undefined) {
    const q = input.q.trim();
    const chars = [...q];
    if (chars.length > 200) {
      if (strict) throw invalidFilter();
      const clipped = chars.slice(0, 200).join('');
      if (clipped) filter.q = clipped;
    } else if (q) filter.q = q;
  }
  if (input.entityId?.trim()) filter.entityId = input.entityId.trim();
  return filter;
}

export function filterFromPageState(state: { kind?: string; operation?: string; source?: string; status?: string; dateFrom?: string; query?: string; selectedId?: string }) {
  // selectedId is intentionally ignored. Bad tokens are dropped so a stale page state cannot fail the assistant.
  return buildFilter({ type: state.kind, op: state.operation, source: state.source, status: state.status, from: state.dateFrom, q: state.query }, false);
}

export function parseChangeListQuery(input: Record<string, unknown>) {
  const limitRaw = queryString(input.limit);
  let limit = 50;
  if (limitRaw !== undefined && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) throw invalidFilter();
    limit = Number(limitRaw);
    if (limit < 1 || limit > 100) throw invalidFilter();
  }
  const filter = buildFilter({
    type: queryString(input.type) ?? queryString(input.entityType),
    op: queryString(input.op),
    source: queryString(input.source),
    status: queryString(input.status),
    from: queryString(input.from),
    q: queryString(input.q),
    entityId: queryString(input.entityId),
  }, true);
  return { limit, cursor: queryString(input.cursor), filter, fingerprint: canonical(filter) };
}

function decodeCursor(cursor: string, fingerprint: string) {
  let value: any;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (!value || value.v !== 1 || value.filter !== fingerprint || typeof value.createdAt !== 'string' || typeof value.id !== 'string') throw invalidCursor();
  return { createdAt: value.createdAt as string, id: value.id as string };
}

function encodeCursor(fingerprint: string, createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, filter: fingerprint, createdAt, id })).toString('base64url');
}

async function namesFor(ids: string[]) {
  const map = new Map<string, string | null>();
  if (!ids.length) return map;
  const rows = await prisma.connection.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  for (const id of ids) map.set(id, null);
  for (const row of rows) map.set(row.id, row.name);
  return map;
}

function toItem(record: ChangeRow, names: Map<string, string | null>): ChangeListItem {
  const reason = blockReason(record);
  const entityName = record.entityName ?? changeDisplayName(record.entityType, record.entityId, record.beforeSnapshot, record.afterSnapshot, record.operation);
  return {
    id: record.id,
    entityType: record.entityType,
    entityId: record.entityId,
    operation: record.operation,
    entityName,
    groupCount: groupCount(record.beforeSnapshot, record.afterSnapshot),
    changeSummary: changeSummary(record),
    source: record.source,
    actorKind: actorKindOf(record.source, record.connectionId),
    connectionId: record.connectionId,
    connectionName: record.connectionId ? names.get(record.connectionId) ?? null : null,
    approvalId: record.approvalId,
    canUndo: reason === null,
    undoBlockedReason: reason,
    undoneAt: record.undoneAt,
    createdAt: record.createdAt,
  };
}

function parsedLimit(value: number | undefined) {
  const limit = value === undefined ? 50 : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidFilter();
  return limit;
}

function isPrepared(input: Record<string, unknown> | { filter: ChangeListFilter; limit?: number; cursor?: string }): input is { filter: ChangeListFilter; limit?: number; cursor?: string } {
  const filter = (input as { filter?: unknown }).filter;
  return Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter);
}

export async function listPage(input: Record<string, unknown> | { filter: ChangeListFilter; limit?: number; cursor?: string }): Promise<ChangePage> {
  const prepared = isPrepared(input) ? input : null;
  const parsed = prepared ? null : parseChangeListQuery(input as Record<string, unknown>);
  const filter = prepared ? prepared.filter : parsed!.filter;
  const limit = prepared ? parsedLimit(prepared.limit) : parsed!.limit;
  const fingerprint = prepared ? canonical(filter) : parsed!.fingerprint;
  const cursorRaw = prepared ? prepared.cursor : parsed!.cursor;
  const cursor = cursorRaw ? decodeCursor(cursorRaw, fingerprint) : null;
  const where = changeListWhere(filter);
  const pageWhere: Prisma.ChangeRecordWhereInput = cursor
    ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] }] }] }
    : where;
  const [rows, total] = await Promise.all([
    prisma.changeRecord.findMany({ where: pageWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 }),
    prisma.changeRecord.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows) as ChangeRow[];
  const pageIds = [...new Set(page.flatMap((row) => row.connectionId ? [row.connectionId] : []))];
  let connections: { id: string; name: string | null }[] | undefined;
  if (!cursor) {
    const distinct = await prisma.changeRecord.findMany({ where: { connectionId: { not: null } }, distinct: ['connectionId'], select: { connectionId: true } });
    const ids = distinct.map((row) => row.connectionId).filter((id): id is string => Boolean(id)).sort((a, b) => a.localeCompare(b));
    const names = await namesFor([...new Set([...ids, ...pageIds])]);
    connections = ids.map((id) => ({ id, name: names.get(id) ?? null }));
    const last = page[page.length - 1];
    return { items: page.map((row) => toItem(row, names)), nextCursor: hasMore && last ? encodeCursor(fingerprint, last.createdAt, last.id) : null, total, connections };
  }
  const names = await namesFor(pageIds);
  const last = page[page.length - 1];
  return { items: page.map((row) => toItem(row, names)), nextCursor: hasMore && last ? encodeCursor(fingerprint, last.createdAt, last.id) : null, total };
}

const LIVE_NAME: Record<string, (client: PrismaClient, ids: string[]) => Promise<{ id: string; name: string }[]>> = {
  task: (client, ids) => client.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }).then((rows) => rows.map((row) => ({ id: row.id, name: row.title }))),
  topic: (client, ids) => client.topic.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  tag: (client, ids) => client.tag.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  material: (client, ids) => client.material.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }).then((rows) => rows.map((row) => ({ id: row.id, name: row.title }))),
  memory: (client, ids) => client.memory.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }).then((rows) => rows.map((row) => ({ id: row.id, name: row.title }))),
  skill: (client, ids) => client.skill.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  entity: (client, ids) => client.entity.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  libraryFolder: (client, ids) => client.libraryFolder.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  libraryTag: (client, ids) => client.libraryTag.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
};

async function liveNameMap(client: PrismaClient, rows: { entityType: string; entityId: string }[]) {
  const map = new Map<string, string>();
  const types = [...new Set(rows.map((row) => row.entityType))];
  await Promise.all(types.map(async (type) => {
    const load = LIVE_NAME[type];
    if (!load) return;
    const ids = [...new Set(rows.filter((row) => row.entityType === type).map((row) => row.entityId))];
    if (!ids.length) return;
    for (const row of await load(client, ids)) map.set(`${type}:${row.id}`, row.name);
  }));
  return map;
}

/** Fills `entity_name` for rows that predate the column. Safe to run again: only NULL rows are touched. */
export async function migrateChangeNames(client: PrismaClient) {
  const size = 200;
  for (;;) {
    const rows = await client.changeRecord.findMany({ where: { entityName: null }, orderBy: { id: 'asc' }, take: size });
    if (!rows.length) return;
    const live = await liveNameMap(client, rows);
    await client.$transaction(rows.map((row) => {
      const parsed = changeDisplayName(row.entityType, row.entityId, row.beforeSnapshot, row.afterSnapshot, row.operation);
      const current = live.get(`${row.entityType}:${row.entityId}`);
      return client.changeRecord.update({ where: { id: row.id }, data: { entityName: current ?? parsed } });
    }));
  }
}
