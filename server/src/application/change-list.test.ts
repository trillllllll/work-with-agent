import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from '../test-auth.js';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ChangeService, ToolService, type ExecutionAdapter } from '../services.js';
import type { Actor } from './security.js';
import { chatContextV3, contextFromRequest, type ChatContextV3 } from '../agent/chat-context.js';
import { readPageState } from '../agent/app-knowledge.js';
import { blockReason, changeDisplayName, changeStatus, filterFromPageState, migrateChangeNames, reversibleOp, syncEntityName, type ChangeStatus } from './change-list.js';

const api = request(app);
const snap = (value: unknown) => JSON.stringify(value);
const both = { beforeSnapshot: '{"title":"before"}', afterSnapshot: '{"title":"after"}' };

async function cleanup() {
  await prisma.changeRecord.deleteMany({ where: { OR: [
    { id: { startsWith: 'zzch' } },
    { entityId: { startsWith: 'zzch' } },
    { entityName: { contains: 'zzch' } },
    { approvalId: { startsWith: 'zzch' } },
  ] } });
  await prisma.task.deleteMany({ where: { title: { contains: 'zzch' } } });
  await prisma.connection.deleteMany({ where: { id: { startsWith: 'zzch' } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe('change display names', () => {
  it('prefers the previous name on delete and the next name otherwise, including nested batches', () => {
    expect(changeDisplayName('task', 'a', { title: 'before' }, { title: 'after' }, 'delete')).toBe('before');
    expect(changeDisplayName('task', 'a', { title: 'before' }, { title: 'after' }, 'archive')).toBe('before');
    expect(changeDisplayName('task', 'a', { title: 'before' }, { title: 'after' }, 'update')).toBe('after');
    expect(changeDisplayName('task', 'a', { title: 'restored' }, { title: 'deleted' }, 'undo:delete')).toBe('deleted');
    const group = { version: 2, entities: { tasks: { a: { title: 'Grouped' }, b: { title: 'Other' } }, topics: {}, tags: {} }, scopes: [] };
    expect(changeDisplayName('task', 'a', null, group, 'create')).toBe('Grouped');
    const nested = { version: 3, changes: [{ entityType: 'task', entityId: 'a', operation: 'update', snapshot: snap({ title: 'inner-name' }) }] };
    expect(changeDisplayName('proposal', 'pid', null, nested, 'batch')).toBe('inner-name');
    expect(changeDisplayName('execution', 'approval', null, { toolName: 'execute_http', input: {}, result: { success: true } }, 'execute')).toBe('execute_http');
  });

  it('drops unknown page-state tokens and ignores selectedId', () => {
    expect(filterFromPageState({ kind: 'task', operation: 'update,bogus', source: 'user', status: 'nope', dateFrom: 'not-a-date', query: ' hello ', selectedId: 'ignore-me' })).toEqual({ type: ['task'], op: ['update'], source: ['user'], q: 'hello' });
    expect(filterFromPageState({ query: 'a'.repeat(250) }).q).toHaveLength(200);
  });
});

describe('GET /api/changes', () => {
  type Item = {
    id: string; operation: string; entityType: string; entityId: string; entityName: string; source: string;
    connectionId: string | null; actorKind: string; canUndo: boolean; groupCount: number; changeSummary: unknown;
    undoBlockedReason: { code: string; reason: string } | null; createdAt: string;
  };

  async function walk(query: Record<string, string | number>) {
    const items: Item[] = [];
    let cursor: string | undefined;
    let total: number | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await api.get('/api/changes').query({ ...query, ...(cursor ? { cursor } : {}) });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const data = response.body.data as { items: Item[]; nextCursor: string | null; total: number };
      if (total === undefined) total = data.total;
      else expect(data.total).toBe(total);
      if (cursor) expect(data).not.toHaveProperty('connections');
      else expect(data).toHaveProperty('connections');
      for (const item of data.items) {
        expect(item).not.toHaveProperty('beforeSnapshot');
        expect(item).not.toHaveProperty('afterSnapshot');
        expect(item).not.toHaveProperty('conversationId');
        expect(item).not.toHaveProperty('requestId');
        expect(item).not.toHaveProperty('reversible');
      }
      items.push(...data.items);
      if (!data.nextCursor) return { items, total: data.total };
      cursor = data.nextCursor;
    }
    throw new Error('pagination did not finish');
  }

  it('pages more than 120 rows without duplicates and keeps the default page at 50', async () => {
    const count = 130;
    await prisma.changeRecord.createMany({ data: Array.from({ length: count }, (_, index) => ({
      id: `zzchp${String(index).padStart(4, '0')}`,
      entityType: 'zzchpage',
      entityId: `zzchp${String(index).padStart(4, '0')}`,
      operation: 'update',
      entityName: 'zzch page',
      source: 'user',
      ...both,
      createdAt: new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString(),
    })) });
    const first = await api.get('/api/changes').query({ type: 'zzchpage' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.items).toHaveLength(50);
    expect(first.body.data.total).toBe(count);
    expect(first.body.data.nextCursor).toBeTruthy();
    expect(first.body.data.items[0].id).toBe('zzchp0129');
    expect(first.body.data.items[49].id).toBe('zzchp0080');
    expect(first.body.data.items[0]).not.toHaveProperty('beforeSnapshot');
    const all = await walk({ type: 'zzchpage' });
    expect(all.total).toBe(count);
    expect(all.items).toHaveLength(count);
    expect(new Set(all.items.map((item) => item.id)).size).toBe(count);
    const stored = await prisma.changeRecord.findMany({ where: { entityType: 'zzchpage' }, select: { id: true } });
    expect(new Set(all.items.map((item) => item.id))).toEqual(new Set(stored.map((row) => row.id)));
  });

  it('does not repeat or skip later pages when a newer row is inserted mid-walk', async () => {
    const count = 60;
    await prisma.changeRecord.createMany({ data: Array.from({ length: count }, (_, index) => ({
      id: `zzchq${String(index).padStart(4, '0')}`,
      entityType: 'zzchpage2',
      entityId: `zzchq${String(index).padStart(4, '0')}`,
      operation: 'update',
      entityName: 'zzch page2',
      source: 'user',
      ...both,
      createdAt: new Date(Date.UTC(2021, 0, 1) + index * 1000).toISOString(),
    })) });
    const first = await api.get('/api/changes').query({ type: 'zzchpage2' });
    expect(first.body.data.items).toHaveLength(50);
    expect(first.body.data.items.map((item: Item) => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `zzchq${String(59 - index).padStart(4, '0')}`));
    await prisma.changeRecord.create({ data: { id: 'zzchq-future', entityType: 'zzchpage2', entityId: 'zzchq-future', operation: 'update', entityName: 'zzch page2', source: 'user', ...both, createdAt: '2099-01-01T00:00:00.000Z' } });
    const second = await api.get('/api/changes').query({ type: 'zzchpage2', cursor: first.body.data.nextCursor });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data).not.toHaveProperty('connections');
    expect(second.body.data.nextCursor).toBeNull();
    expect(second.body.data.items.map((item: Item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `zzchq${String(9 - index).padStart(4, '0')}`));
    const again = await api.get('/api/changes').query({ type: 'zzchpage2' });
    expect(again.body.data.total).toBe(count + 1);
    expect(again.body.data.items[0].id).toBe('zzchq-future');
  });

  it('combines type, operation group, source, status, time, and name filters', async () => {
    await prisma.connection.create({ data: { id: 'zzchfconn', name: 'ZZ Filter', host: 'https://zzch.example', tokenHash: 'zzch-token-filter', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' } });
    const hour = (value: number) => `2026-06-15T${String(value).padStart(2, '0')}:00:00.000Z`;
    await prisma.changeRecord.createMany({ data: [
      { id: 'zzchf01', entityType: 'task', entityId: 'zzchf01', operation: 'update', source: 'user', entityName: 'zzchfilt Alpha', beforeSnapshot: snap({ title: 'Alpha', status: 'todo' }), afterSnapshot: snap({ title: 'Alpha', status: 'doing' }), createdAt: hour(1) },
      { id: 'zzchf02', entityType: 'task', entityId: 'zzchf02', operation: 'undo:update', source: 'user', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(2) },
      { id: 'zzchf03', entityType: 'handoff', entityId: 'zzchf03', operation: 'prepare', source: 'agent', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(3) },
      { id: 'zzchf04', entityType: 'task', entityId: 'zzchf04', operation: 'create', source: 'mcp', entityName: 'zzchfilt Beta', beforeSnapshot: null, afterSnapshot: snap({ title: 'Beta' }), createdAt: hour(4) },
      { id: 'zzchf05', entityType: 'task', entityId: 'zzchf05', operation: 'update', source: 'user', connectionId: 'zzchfconn', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(5) },
      { id: 'zzchf06', entityType: 'task', entityId: 'zzchf06', operation: 'delete', source: 'user', entityName: 'zzchfilt Alpha', beforeSnapshot: snap({ title: 'Alpha' }), afterSnapshot: null, undoneAt: hour(6), createdAt: hour(6) },
      { id: 'zzchf07', entityType: 'task', entityId: 'zzchf07', operation: 'archive', source: 'user', entityName: 'zzchfilt Gamma', ...both, createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 'zzchf08', entityType: 'topic', entityId: 'zzchf08', operation: 'confirm_summary', source: 'agent', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(8) },
      { id: 'zzchf09', entityType: 'execution', entityId: 'zzchf09', operation: 'execute', source: 'agent', entityName: 'zzchfilt tool', beforeSnapshot: null, afterSnapshot: snap({ toolName: 'echo', input: {}, result: { success: true } }), createdAt: hour(9) },
      { id: 'zzchf10', entityType: 'task', entityId: 'zzchf10', operation: 'permanent_delete', source: 'user', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(10) },
      { id: 'zzchf11', entityType: 'run', entityId: 'zzchf11', operation: 'start', source: 'agent', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(11) },
      { id: 'zzchf12', entityType: 'workspace', entityId: 'zzchf12', operation: 'batch', source: 'user', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(12) },
      { id: 'zzchf13', entityType: 'proposal', entityId: 'zzchf13', operation: 'undo:batch', source: 'user', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(13) },
      { id: 'zzchf14', entityType: 'material', entityId: 'zzchf14', operation: 'permanent_delete', source: 'user', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(14) },
      { id: 'zzchf15', entityType: 'task', entityId: 'zzchf15', operation: 'update', source: 'user', entityName: 'zzchfilt Alpha', beforeSnapshot: null, afterSnapshot: null, createdAt: hour(15) },
      { id: 'zzchf16', entityType: 'task', entityId: 'zzchf16', operation: 'create', source: 'user', entityName: 'zzchfilt OnlyAfter', beforeSnapshot: null, afterSnapshot: snap({ title: 'OnlyAfter' }), createdAt: hour(16) },
      { id: 'zzchf17', entityType: 'task', entityId: 'zzchf17', operation: 'delete', source: 'user', entityName: 'zzchfilt OnlyBefore', beforeSnapshot: snap({ title: 'OnlyBefore' }), afterSnapshot: null, createdAt: hour(17) },
      { id: 'zzchf18', entityType: 'handoff', entityId: 'zzchf18', operation: 'review', source: 'agent', connectionId: 'zzchgoneconn', entityName: 'zzchfilt Alpha', ...both, createdAt: hour(18) },
    ] });

    const combined = await walk({ type: 'task', op: 'update', source: 'user', status: 'reversible', from: '2026-06-01', q: 'zzchfilt Alpha' });
    expect(combined.items.map((item) => item.id)).toEqual(['zzchf01']);
    expect(combined.total).toBe(1);
    expect(combined.items[0].changeSummary).toEqual({ field: 'status', before: 'todo', after: 'doing' });
    expect(combined.items[0].actorKind).toBe('user');

    const undo = await walk({ op: 'undo', q: 'zzchfilt' });
    expect(undo.items.map((item) => item.id).sort()).toEqual(['zzchf02', 'zzchf13']);
    expect(undo.items.every((item) => item.operation.startsWith('undo:'))).toBe(true);

    const other = await walk({ op: 'other', q: 'zzchfilt', limit: 2 });
    expect(other.total).toBe(4);
    expect(other.items.map((item) => item.id).sort()).toEqual(['zzchf03', 'zzchf11', 'zzchf12', 'zzchf18']);
    const named = new Set(['create', 'update', 'reorder', 'move_tasks_to_inbox', 'delete', 'archive', 'archive_preserve', 'permanent_delete', 'restore', 'confirm_summary', 'discard_summary', 'execute']);
    expect(other.items.every((item) => !named.has(item.operation) && !item.operation.startsWith('undo:'))).toBe(true);

    const assistant = await walk({ source: 'assistant', q: 'zzchfilt', limit: 2 });
    expect(assistant.items.map((item) => item.id).sort()).toEqual(['zzchf03', 'zzchf04', 'zzchf08', 'zzchf09', 'zzchf11']);
    expect(assistant.items.every((item) => item.source !== 'user' && item.connectionId === null)).toBe(true);
    expect(assistant.items.find((item) => item.id === 'zzchf04')).toMatchObject({ source: 'mcp', actorKind: 'assistant' });

    const users = await walk({ source: 'user', q: 'zzchfilt' });
    expect(users.items.some((item) => item.id === 'zzchf05')).toBe(false);
    expect(users.items.every((item) => item.source === 'user' && item.connectionId === null)).toBe(true);
    const connected = await api.get('/api/changes').query({ source: 'c:zzchfconn', q: 'zzchfilt' });
    expect(connected.body.data.items.map((item: Item) => item.id)).toEqual(['zzchf05']);
    expect(connected.body.data.items[0].actorKind).toBe('connection');
    expect(connected.body.data.connections).toEqual(expect.arrayContaining([{ id: 'zzchfconn', name: 'ZZ Filter' }, { id: 'zzchgoneconn', name: null }]));

    const deleted = await walk({ op: 'delete', q: 'zzchfilt', from: '2026-06-01T00:00:00.000Z' });
    expect(deleted.items.map((item) => item.id).sort()).toEqual(['zzchf06', 'zzchf10', 'zzchf14', 'zzchf17']);
    expect(deleted.items.some((item) => item.id === 'zzchf07')).toBe(false);

    const created = await api.get('/api/changes').query({ entityId: 'zzchf16' });
    expect(created.body.data.items[0]).toMatchObject({ canUndo: true, changeSummary: null, undoBlockedReason: null });
    const tool = await api.get('/api/changes').query({ entityId: 'zzchf09' });
    expect(tool.body.data.items[0].changeSummary).toEqual({ kind: 'tool', toolName: 'echo', success: true });
    expect(tool.body.data.items[0].canUndo).toBe(false);
  });

  it('matches a full id, a name fragment, and English text that only looks like an id', async () => {
    await prisma.changeRecord.createMany({ data: [
      { id: 'zzch-name-idlike', entityType: 'task', entityId: 'zzch_other_entity_01', operation: 'update', entityName: 'QuarterlyPlanningNote', source: 'user', ...both, createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 'zzch-id-exact', entityType: 'task', entityId: 'QuarterlyPlanningNote', operation: 'update', entityName: 'different label', source: 'user', ...both, createdAt: '2026-07-02T00:00:00.000Z' },
      { id: 'zzch-id-only', entityType: 'task', entityId: 'zzchExactId00000001', operation: 'update', entityName: 'no-match-here', source: 'user', ...both, createdAt: '2026-07-03T00:00:00.000Z' },
      { id: 'zzch-english-space', entityType: 'task', entityId: 'zzch_space_entity_01', operation: 'update', entityName: 'Release Notes', source: 'user', ...both, createdAt: '2026-07-04T00:00:00.000Z' },
      { id: 'zzch-case', entityType: 'task', entityId: 'zzch_case_entity_01', operation: 'update', entityName: 'ZzchCaseMarker', source: 'user', ...both, createdAt: '2026-07-05T00:00:00.000Z' },
    ] });
    const ids = async (q: string) => {
      const response = await api.get('/api/changes').query({ q, limit: 100 });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body.data.items as Item[]).map((item) => item.id).filter((id) => id.startsWith('zzch-')).sort();
    };
    expect(await ids('QuarterlyPlanningNote')).toEqual(['zzch-id-exact', 'zzch-name-idlike']);
    expect(await ids('zzchExactId00000001')).toEqual(['zzch-id-only']);
    expect(await ids('no-match')).toEqual(['zzch-id-only']);
    expect(await ids('Release Notes')).toEqual(['zzch-english-space']);
    expect(await ids('zzchcasemarker')).toEqual(['zzch-case']);
  });

  it('keeps status SQL aligned with blockReason', async () => {
    expect(reversibleOp('material', 'permanent_delete')).toBe(true);
    expect(reversibleOp('material', 'update')).toBe(true);
    const matrix: Array<{ id: string; entityType: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null; undoneAt?: string; status: ChangeStatus; reason: string | null }> = [
      { id: 'zzchm-undone', entityType: 'task', operation: 'update', ...both, undoneAt: '2026-01-02T00:00:00.000Z', status: 'undone', reason: 'already_undone' },
      { id: 'zzchm-undo', entityType: 'task', operation: 'undo:update', ...both, status: 'blocked', reason: 'undo_record' },
      { id: 'zzchm-exec', entityType: 'execution', operation: 'execute', beforeSnapshot: null, afterSnapshot: snap({ toolName: 'echo' }), status: 'blocked', reason: 'execution' },
      { id: 'zzchm-perm', entityType: 'task', operation: 'permanent_delete', ...both, status: 'blocked', reason: 'permanent_delete' },
      { id: 'zzchm-mat', entityType: 'material', operation: 'permanent_delete', ...both, status: 'blocked', reason: 'permanent_delete' },
      { id: 'zzchm-empty', entityType: 'task', operation: 'update', beforeSnapshot: null, afterSnapshot: null, status: 'blocked', reason: 'missing_snapshot' },
      { id: 'zzchm-blank', entityType: 'task', operation: 'update', beforeSnapshot: '', afterSnapshot: '', status: 'blocked', reason: 'missing_snapshot' },
      { id: 'zzchm-ok', entityType: 'task', operation: 'update', ...both, status: 'reversible', reason: null },
      { id: 'zzchm-create', entityType: 'task', operation: 'create', beforeSnapshot: null, afterSnapshot: snap({ title: 'created' }), status: 'reversible', reason: null },
      { id: 'zzchm-delete', entityType: 'task', operation: 'delete', beforeSnapshot: snap({ title: 'removed' }), afterSnapshot: null, status: 'reversible', reason: null },
      { id: 'zzchm-exec-undone', entityType: 'execution', operation: 'execute', ...both, undoneAt: '2026-01-03T00:00:00.000Z', status: 'undone', reason: 'already_undone' },
      { id: 'zzchm-other', entityType: 'handoff', operation: 'prepare', ...both, status: 'blocked', reason: 'unsupported' },
    ];
    await prisma.changeRecord.createMany({ data: matrix.map(({ status: _status, reason: _reason, ...row }) => ({ ...row, entityId: row.id, source: 'user', entityName: 'zzch-matrix', createdAt: '2026-02-01T00:00:00.000Z' })) });
    const stored = await prisma.changeRecord.findMany({ where: { entityName: 'zzch-matrix' } });
    expect(stored).toHaveLength(matrix.length);
    for (const spec of matrix) {
      const row = stored.find((item) => item.id === spec.id);
      expect(row, spec.id).toBeTruthy();
      expect(blockReason(row!)?.reason ?? null, spec.id).toBe(spec.reason);
      expect(changeStatus(row!), spec.id).toBe(spec.status);
    }
    for (const status of ['reversible', 'undone', 'blocked'] as const) {
      const response = await api.get('/api/changes').query({ q: 'zzch-matrix', status, limit: 100 });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const items = response.body.data.items as Item[];
      expect(items.map((item) => item.id).sort()).toEqual(matrix.filter((row) => row.status === status).map((row) => row.id).sort());
      expect(response.body.data.total).toBe(items.length);
      for (const item of items) {
        const spec = matrix.find((row) => row.id === item.id)!;
        expect(item.canUndo).toBe(spec.reason === null);
        expect(item.undoBlockedReason?.reason ?? null).toBe(spec.reason);
      }
    }
  });

  it('rejects a cursor from another filter and a cursor that cannot be decoded', async () => {
    await prisma.changeRecord.createMany({ data: [0, 1].map((index) => ({ id: `zzchcur${index}`, entityType: 'zzchcur', entityId: `zzchcur${index}`, operation: 'create', entityName: 'zzch cursor', source: 'user', beforeSnapshot: null, afterSnapshot: '{}', createdAt: `2026-03-0${index + 1}T00:00:00.000Z` })) });
    const first = await api.get('/api/changes').query({ type: 'zzchcur', op: 'create,update', limit: 1 });
    expect(first.body.data.nextCursor).toBeTruthy();
    const swapped = await api.get('/api/changes').query({ type: 'zzchcur', op: 'update,create', limit: 1, cursor: first.body.data.nextCursor });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const mismatch = await api.get('/api/changes').query({ type: 'task', cursor: first.body.data.nextCursor });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ code: 'INVALID_CURSOR', error: '分页游标无效' });
    const corrupt = await api.get('/api/changes').query({ cursor: '@@@not-a-cursor@@@' });
    expect(corrupt.status).toBe(400);
    expect(corrupt.body).toMatchObject({ code: 'INVALID_CURSOR', error: '分页游标无效' });
    expect(JSON.stringify(mismatch.body) + JSON.stringify(corrupt.body)).not.toContain('游标不属于当前查询');
    const unknown = await api.get('/api/changes').query({ op: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ code: 'VALIDATION_ERROR', error: '筛选参数无效' });
    expect((await api.get('/api/changes').query({ limit: 0 })).status).toBe(400);
    expect((await api.get('/api/changes').query({ limit: 101 })).status).toBe(400);
    expect((await api.get('/api/changes').query({ q: 'x'.repeat(201) })).status).toBe(400);
  });
});

describe('change names, backfill, and undo reasons', () => {
  it('keeps history searchable by the current name and shows the pre-delete name', async () => {
    const created = await api.post('/api/tasks').send({ title: 'zzch old title' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = created.body.data.id as string;
    const renamed = await api.patch(`/api/tasks/${taskId}`).send({ title: 'zzch new title' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const history = await api.get('/api/changes').query({ q: 'zzch new title', entityId: taskId });
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.data.items.map((item: { operation: string }) => item.operation)).toEqual(expect.arrayContaining(['create', 'update']));
    expect(history.body.data.items.every((item: { entityName: string }) => item.entityName === 'zzch new title')).toBe(true);
    expect((await api.get('/api/changes').query({ q: 'zzch old title', entityId: taskId })).body.data.total).toBe(0);
    expect((await api.delete(`/api/tasks/${taskId}`)).status).toBe(200);
    const afterDelete = await api.get('/api/changes').query({ q: 'zzch new title', entityId: taskId });
    expect(afterDelete.body.data.items.find((item: { operation: string }) => item.operation === 'delete').entityName).toBe('zzch new title');
    expect(afterDelete.body.data.items.every((item: { entityName: string }) => item.entityName === 'zzch new title')).toBe(true);
  });

  it('backfills null names once and does not overwrite a name that is already stored', async () => {
    const created = await api.post('/api/tasks').send({ title: 'zzch live name' });
    const taskId = created.body.data.id as string;
    await prisma.changeRecord.create({ data: { id: 'zzch-null-name', entityType: 'task', entityId: taskId, operation: 'update', source: 'user', entityName: null, beforeSnapshot: snap({ title: 'zzch snap only' }), afterSnapshot: snap({ title: 'zzch snap only' }), createdAt: '2026-04-01T00:00:00.000Z' } });
    const beforeFill = await api.get('/api/changes').query({ entityId: taskId });
    expect(beforeFill.body.data.items.find((item: { id: string }) => item.id === 'zzch-null-name').entityName).toBe('zzch snap only');
    await prisma.changeRecord.create({ data: { id: 'zzch-frozen-name', entityType: 'task', entityId: taskId, operation: 'update', source: 'user', entityName: 'zzch frozen', ...both, createdAt: '2026-04-02T00:00:00.000Z' } });
    await prisma.changeRecord.create({ data: { id: 'zzch-missing-entity', entityType: 'task', entityId: 'zzch-missing-task', operation: 'delete', source: 'user', entityName: null, beforeSnapshot: snap({ title: 'zzch parsed name' }), afterSnapshot: null, createdAt: '2026-04-03T00:00:00.000Z' } });
    await migrateChangeNames(prisma);
    expect((await prisma.changeRecord.findUnique({ where: { id: 'zzch-null-name' } }))!.entityName).toBe('zzch live name');
    expect((await prisma.changeRecord.findUnique({ where: { id: 'zzch-frozen-name' } }))!.entityName).toBe('zzch frozen');
    expect((await prisma.changeRecord.findUnique({ where: { id: 'zzch-missing-entity' } }))!.entityName).toBe('zzch parsed name');
    const read = () => prisma.changeRecord.findMany({ where: { id: { in: ['zzch-null-name', 'zzch-frozen-name', 'zzch-missing-entity'] } }, select: { id: true, entityName: true }, orderBy: { id: 'asc' } });
    const once = await read();
    await migrateChangeNames(prisma);
    expect(await read()).toEqual(once);
  });

  it('does not rewrite member history for a batch row, and records a connection on execution', async () => {
    await prisma.changeRecord.create({ data: { id: 'zzch-batch-member', entityType: 'task', entityId: 'zzch-batch-entity', operation: 'update', entityName: 'member-name', source: 'user', ...both, createdAt: '2026-01-01T00:00:00.000Z' } });
    await prisma.$transaction(async (tx) => {
      await syncEntityName(tx, 'task', 'zzch-batch-entity', 'batch', 'batch-name');
      await syncEntityName(tx, 'task', 'zzch-batch-entity', 'undo:batch', 'batch-name');
      await syncEntityName(tx, 'task', 'zzch-batch-entity', 'update', '');
    });
    expect((await prisma.changeRecord.findUnique({ where: { id: 'zzch-batch-member' } }))!.entityName).toBe('member-name');
    await prisma.$transaction((tx) => syncEntityName(tx, 'task', 'zzch-batch-entity', 'update', 'renamed-member'));
    expect((await prisma.changeRecord.findUnique({ where: { id: 'zzch-batch-member' } }))!.entityName).toBe('renamed-member');

    await prisma.connection.create({ data: { id: 'zzchexecconn', name: 'ZZ Exec', host: 'https://exec.example', tokenHash: 'zzch-token-exec', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' } });
    const actor: Actor = { id: 'connection:zzchexecconn', kind: 'connection', connectionId: 'zzchexecconn', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
    const adapter: ExecutionAdapter = { execute: async () => ({ success: true, data: { output: 'ok' }, durationMs: 1, reversible: false, redacted: true }) };
    const approvalId = 'zzch-approval-exec';
    const result = await new ToolService(adapter).execute({ name: 'execute_http', arguments: { url: 'https://example.test?api_key=url-hidden', headers: { authorization: 'Bearer hidden' }, body: { apiKey: 'body-hidden' } } }, { source: 'agent', approvalId, conversationId: 'zzch-conversation', actor });
    expect(result.success).toBe(true);
    const record = await prisma.changeRecord.findFirst({ where: { entityId: approvalId } });
    expect(record).toMatchObject({ connectionId: 'zzchexecconn', actorId: actor.id, entityName: 'execute_http', source: 'agent' });
    const listed = await api.get('/api/changes').query({ entityId: approvalId });
    expect(listed.body.data.items[0]).toMatchObject({ actorKind: 'connection', connectionId: 'zzchexecconn', connectionName: 'ZZ Exec', canUndo: false, undoBlockedReason: { reason: 'execution' } });
  });

  it('uses the new undo messages and still refuses execution records', async () => {
    const cases = [
      ['zzchm-undo', 'CHANGE_NOT_REVERSIBLE', '这是一条撤销记录，不能再撤销'],
      ['zzchm-exec', 'CHANGE_NOT_REVERSIBLE', '受控执行记录不可撤销'],
      ['zzchm-perm', 'CHANGE_NOT_REVERSIBLE', '此类操作不支持撤销（永久删除）'],
      ['zzchm-mat', 'CHANGE_NOT_REVERSIBLE', '此类操作不支持撤销（永久删除）'],
      ['zzchm-empty', 'MISSING_SNAPSHOT', '缺少变更前后的快照，无法撤销'],
      ['zzchm-undone', 'CHANGE_ALREADY_UNDONE', '该变更已经撤销'],
    ] as const;
    for (const [id, code, error] of cases) {
      const response = await api.post(`/api/changes/${id}/undo`);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({ code, error });
    }
    await expect(new ChangeService().undo('zzchm-undo')).rejects.toThrow('这是一条撤销记录，不能再撤销');
    await expect(new ChangeService().undo('zzchm-exec')).rejects.toThrow('受控执行记录不可撤销');
  });

  it('reads the changes page with operation and source and ignores selectedId', async () => {
    const context = (pageState: ChatContextV3['pageState']): ChatContextV3 => ({
      schemaVersion: 3, page: 'changes', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null,
      timeZone: 'Asia/Shanghai', referencedApprovalId: null, label: '变更', section: null, mode: 'follow', taskRevision: null, materialRevision: null,
      selectedMaterialIds: [], pageState, attachments: [],
    });
    expect(chatContextV3.safeParse(context({ operation: 'update', source: 'assistant' })).success).toBe(true);
    expect(chatContextV3.safeParse(context({ operation: 'x'.repeat(301) })).success).toBe(false);
    await prisma.changeRecord.createMany({ data: [
      { id: 'zzchps1', entityType: 'task', entityId: 'zzchps-a', operation: 'update', entityName: 'zzch-page-state', source: 'user', ...both, createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'zzchps2', entityType: 'topic', entityId: 'zzchps-b', operation: 'update', entityName: 'zzch-page-state', source: 'user', ...both, createdAt: '2026-08-02T00:00:00.000Z' },
      { id: 'zzchps3', entityType: 'task', entityId: 'zzchps-c', operation: 'delete', entityName: 'zzch-page-state', source: 'mcp', beforeSnapshot: '{}', afterSnapshot: null, createdAt: '2026-08-03T00:00:00.000Z' },
    ] });
    const data = await readPageState(contextFromRequest({ context: context({ kind: 'task', operation: 'update', source: 'user', selectedId: 'zzchps-b', query: 'zzch-page-state' }) }));
    if (!('changes' in data) || !('coverage' in data)) throw new Error('changes page state was not read');
    expect(data.coverage).toBe('当前筛选下最近 30 条');
    expect(data.changes.map((row) => row.id)).toEqual(['zzchps1']);
  });
});
