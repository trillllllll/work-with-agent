import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserOfflineRuntime, browserReplica, enableBrowserReplica } from './offline-runtime.js';
import { emptyReplicaRows, OfflineStore, type BrowserReplica } from './offline-store.js';
import { canonicalSyncRow, mergeSyncRow, syncRowsEqual, type SyncRow } from '../../../server/src/application/sync-merge.js';

const stamp = '2026-10-25T10:00:00.000Z';
const row = (patch: SyncRow = {}) => canonicalSyncRow('task', { title: '任务', description: '', status: 'todo', priority: 'none', dueDate: null, estimatedMinutes: null, scheduledStart: null, scheduledEnd: null, resultSummary: '', recurrenceRule: '', topicId: null, parentId: null, deletedAt: null, deleteBatchId: null, sortOrder: 0, tagIds: [], createdAt: stamp, completedAt: null, completedAtEstimated: false, ...patch })!;
const initial = (scope: string): BrowserReplica => ({ scope, workspaceId: 'workspace-test', schemaVersion: 'protocol-test', actorId: 'owner', token: 'fixture-device-token', authenticatedAt: Date.now(), ready: false, cursor: 0, base: emptyReplicaRows(), rows: emptyReplicaRows(), outbox: [], receipts: {}, previews: {}, lastSuccessAt: null, lastError: null });

function hub() {
  const tasks: Record<string, SyncRow> = { task: row() };
  const ops: any[] = [], receipts = new Map<string, any>(), conflicts: unknown[] = [];
  let loseAck = false;
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://test.local');
    let data: any;
    if (url.pathname.endsWith('/snapshot')) data = { schemaVersion: 'protocol-test', tip: ops.length, entities: { topic: [], tag: [], task: Object.entries(tasks).map(([id, row]) => ({ id, row })) } };
    else if (url.pathname.endsWith('/push')) {
      data = { tip: 0, results: JSON.parse(String(init?.body)).ops.map((op: any) => {
        if (receipts.has(op.opId)) return { ...receipts.get(op.opId), status: 'duplicate' };
        const live = tasks[op.entityId] ?? null;
        const merged = mergeSyncRow('task', live, op.before, op.after);
        let seq: number | null = null;
        if (!syncRowsEqual('task', live, merged.row)) {
          seq = ops.length + 1;
          ops.push({ ...op, seq, before: live, after: merged.row });
          if (merged.row) tasks[op.entityId] = merged.row; else delete tasks[op.entityId];
        }
        conflicts.push(...merged.conflicts);
        const result = { opId: op.opId, status: merged.conflicts.length ? 'conflict' : 'applied', seq, landed: merged.row };
        receipts.set(op.opId, result); return result;
      }) };
      data.tip = ops.length;
      if (loseAck) { loseAck = false; throw new TypeError('Connection lost after commit'); }
    } else if (url.pathname.endsWith('/pull')) data = { schemaVersion: 'protocol-test', tip: ops.length, ops: ops.filter(op => op.seq > Number(url.searchParams.get('after'))) };
    else throw new Error('Unexpected fixture endpoint');
    return Response.json({ data, error: null });
  });
  return { tasks, ops, receipts, conflicts, fetcher, dropAck: () => { loseAck = true; } };
}
async function replica(scope: string, store = new OfflineStore(new IDBFactory())) {
  await store.update(scope, () => ({ state: initial(scope), value: undefined }));
  const runtime = new BrowserOfflineRuntime(scope, async () => ({ data: { workspaceId: 'workspace-test', schemaVersion: 'protocol-test' }, error: null }), store);
  await runtime.sync(); runtime.pause(); return runtime;
}
const edit = async (runtime: BrowserOfflineRuntime, patch: Record<string, unknown>, id = 'task') => {
  const revision = (await runtime.status())!.rows.task[id].revision;
  return runtime.request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: revision, ...patch }), headers: { 'X-Request-ID': crypto.randomUUID() } });
};

describe('durable browser workspace', () => {
  beforeEach(() => {
    const target = new EventTarget() as EventTarget & { location: { origin: string } };
    target.location = { origin: 'https://test.local' };
    vi.stubGlobal('window', target); vi.stubGlobal('location', target.location);
  });
  afterEach(async () => { await enableBrowserReplica('owner', 'local', async () => ({ data: {}, error: null })); vi.unstubAllGlobals(); });

  it('commits the business view and outbox atomically and retains both after reopening', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const factory = new IDBFactory(), store = new OfflineStore(factory), runtime = await replica('a', store);
    await edit(runtime, { description: '断网新增的正文' });
    await store.close();
    const reopened = new OfflineStore(factory), state = (await reopened.read('a'))!;
    expect(state.rows.task.task.row.description).toBe('断网新增的正文');
    expect(state.outbox).toHaveLength(1);
    await expect(reopened.update('a', value => { value!.outbox = []; value!.rows.task.task.row.description = '不得提交'; throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await reopened.read('a'))!.rows.task.task.row.description).toBe('断网新增的正文');
    expect((await reopened.read('a'))!.outbox).toHaveLength(1);
  });

  it('does not create twice for the same request and rejects changed request content', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const runtime = await replica('a'), requestId = crypto.randomUUID();
    const init = { method: 'POST', body: JSON.stringify({ title: '离线创建' }), headers: { 'X-Request-ID': requestId } };
    expect((await runtime.request('/api/tasks', init)).data.id).toBe(requestId);
    expect((await runtime.request('/api/tasks', init)).data.id).toBe(requestId);
    expect((await runtime.status())!.outbox).toHaveLength(1);
    await expect(runtime.request('/api/tasks', { ...init, body: JSON.stringify({ title: '另一内容' }) })).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
  });

  it('serializes simultaneous edits to the same local revision', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const runtime = await replica('a'), revision = (await runtime.status())!.rows.task.task.revision;
    const update = (title: string) => runtime.request('/api/tasks/task', { method: 'PATCH', body: JSON.stringify({ title, expectedRevision: revision }) });
    const results = await Promise.allSettled([update('甲'), update('乙')]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect((await runtime.status())!.outbox).toHaveLength(1);
  });

  it('merges distinct offline edits from two devices and retains both versions of a field conflict', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const a = await replica('a'), b = await replica('b');
    await edit(a, { title: '甲的标题' }); await edit(b, { description: '乙的正文' });
    a.resume(); b.resume(); await a.sync(); await b.sync(); await a.sync();
    expect((await a.status())!.rows.task.task.row).toMatchObject({ title: '甲的标题', description: '乙的正文' });
    expect((await b.status())!.rows.task.task.row).toMatchObject({ title: '甲的标题', description: '乙的正文' });
    a.pause(); b.pause(); await edit(a, { title: '先到' }); await edit(b, { title: '后到' });
    a.resume(); b.resume(); await a.sync(); await b.sync();
    expect(remote.tasks.task.title).toBe('先到');
    expect(remote.conflicts).toContainEqual(expect.objectContaining({ field: 'title', incoming: '后到' }));
  });

  it('retries a lost acknowledgement after a new runtime opens without executing again', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const store = new OfflineStore(new IDBFactory()), runtime = await replica('a', store);
    await edit(runtime, { description: '已提交但确认丢失' });
    remote.dropAck(); runtime.resume();
    await expect(runtime.sync()).rejects.toThrow('Connection lost');
    expect((await runtime.status())!.outbox).toHaveLength(1);
    const restarted = new BrowserOfflineRuntime('a', async () => ({ data: { workspaceId: 'workspace-test', schemaVersion: 'protocol-test' }, error: null }), store);
    await restarted.sync();
    expect(remote.ops).toHaveLength(1); expect(remote.receipts.size).toBe(1);
    expect((await restarted.status())!.outbox).toHaveLength(0);
    expect((await restarted.status())!.rows.task.task.row.description).toBe('已提交但确认丢失');
  });

  it('requires a stable preview for cascade mutations and never mutates before confirmation', async () => {
    const remote = hub(); remote.tasks.child = row({ parentId: 'task', title: '子任务' }); vi.stubGlobal('fetch', remote.fetcher);
    const runtime = await replica('a'), state = (await runtime.status())!;
    const input = { expectedRevision: state.rows.task.task.revision }, requestId = crypto.randomUUID();
    let commands: unknown;
    try { await runtime.request('/api/tasks/task', { method: 'DELETE', body: JSON.stringify(input), headers: { 'X-Request-ID': requestId } }); } catch (error: any) { expect(error.code).toBe('PREVIEW_REQUIRED'); commands = error.details.commands; }
    expect((await runtime.status())!.rows.task.task.row.deletedAt).toBe(null);
    const preview = await runtime.request('/api/v1/commands/preview', { method: 'POST', body: JSON.stringify({ requestId, commands }) });
    await runtime.request('/api/tasks/task', { method: 'DELETE', body: JSON.stringify({ ...input, previewToken: preview.data.previewToken }), headers: { 'X-Request-ID': requestId } });
    expect((await runtime.status())!.rows.task.task.row.deletedAt).toBeTruthy();
    expect((await runtime.status())!.rows.task.child.row.deletedAt).toBeTruthy();
    expect((await runtime.status())!.outbox).toHaveLength(2);
  });

  it('isolates cached history by workspace and actor scope', async () => {
    const store = new OfflineStore(new IDBFactory());
    await store.cache('origin:workspace:a', '/api/conversations', { data: ['private'], error: null });
    expect(await store.cached('origin:workspace:b', '/api/conversations')).toBeUndefined();
    expect(await store.cached('origin:workspace:a', '/api/conversations')).toEqual({ data: ['private'], error: null });
  });

  it('spawns the next occurrence offline when completing a recurring task and pushes both rows in one cycle', async () => {
    const remote = hub(); remote.tasks.task = row({ dueDate: '2026-10-20', recurrenceRule: '{"unit":"week","step":1}' }); vi.stubGlobal('fetch', remote.fetcher);
    const runtime = await replica('recurrence');
    const input = { status: 'done' }, requestId = crypto.randomUUID();
    const revision = (await runtime.status())!.rows.task.task.revision;
    let commands: unknown;
    try { await runtime.request('/api/tasks/task', { method: 'PATCH', body: JSON.stringify({ ...input, expectedRevision: revision }), headers: { 'X-Request-ID': requestId } }); } catch (error: any) { expect(error.code).toBe('PREVIEW_REQUIRED'); commands = error.details.commands; }
    const preview = await runtime.request('/api/v1/commands/preview', { method: 'POST', body: JSON.stringify({ requestId, commands }) });
    await runtime.request('/api/tasks/task', { method: 'PATCH', body: JSON.stringify({ ...input, expectedRevision: revision, previewToken: preview.data.previewToken }), headers: { 'X-Request-ID': requestId } });
    const state = (await runtime.status())!;
    expect(state.rows.task.task.row.status).toBe('done');
    const next = Object.values(state.rows.task).find(item => item.id !== 'task')!;
    expect(next.row).toMatchObject({ status: 'todo', dueDate: '2026-10-27', recurrenceRule: '{"unit":"week","step":1}', title: '任务' });
    runtime.resume(); await runtime.sync();
    expect(remote.tasks.task.status).toBe('done');
    const hubNext = Object.entries(remote.tasks).find(([id]) => id !== 'task')!;
    expect(hubNext[1].dueDate).toBe('2026-10-27');
    expect((await runtime.status())!.outbox).toHaveLength(0);
  });

  it('never treats a preview or pending proposal as committed task data', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const runtime = await replica('preview');
    const preview = { data: { preview: [{ after: { id: 'task', ...row({ title: '仅用于预览' }), revision: 9 } }] }, error: null };
    expect(await runtime.afterOnline('/api/v1/commands/preview', { method: 'POST' }, preview)).toBe(preview);
    const proposal = { data: { status: 'pending_approval', results: [{ id: 'task', ...row({ title: '尚未批准' }), revision: 9 }] }, error: null };
    expect(await runtime.afterOnline('/api/v1/commands', { method: 'POST' }, proposal)).toBe(proposal);
    expect((await runtime.status())!.rows.task.task.row.title).toBe('任务');
  });

  it('maps a locally observed task revision to the real hub revision without allowing stale content', async () => {
    const remote = hub(); vi.stubGlobal('fetch', remote.fetcher);
    const original = await replica('revisions');
    let cloudTitle = '任务';
    const runtime = new BrowserOfflineRuntime('revisions', async path => ({ data: path.includes('/identity') ? { workspaceId: 'workspace-test', schemaVersion: 'protocol-test' } : { id: 'task', ...row({ title: cloudTitle }), revision: 17 }, error: null }), original.store);
    const revision = (await runtime.status())!.rows.task.task.revision;
    const result = await runtime.prepareOnline('/api/v1/handoffs', { method: 'POST', body: JSON.stringify({ taskId: 'task', expectedTaskRevision: revision, instruction: '交接' }) });
    expect(JSON.parse(String(result!.body)).expectedTaskRevision).toBe(17);
    cloudTitle = '其他设备的新标题';
    await expect(runtime.prepareOnline('/api/v1/handoffs', { method: 'POST', body: JSON.stringify({ taskId: 'task', expectedTaskRevision: revision }) })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('retains recovery state after an activation failure and can renew a revoked device without losing intents', async () => {
    const remote = hub(), factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const marker = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => marker.get(key) ?? null, setItem: (key: string, value: string) => marker.set(key, value) });
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => new Headers(init?.headers).get('authorization') === 'Bearer revoked' ? Response.json({ error: 'revoked' }, { status: 401 }) : remote.fetcher(path, init));
    let identityCalls = 0, failAt = -1, pairs = 0;
    const network = async (path: string) => {
      if (path.endsWith('/identity')) { identityCalls++; if (identityCalls === failAt) throw new TypeError('temporary outage'); return { data: { workspaceId: 'workspace-test', schemaVersion: 'protocol-test' }, error: null as null }; }
      pairs++; return { data: { token: 'replacement-device-token' }, error: null as null };
    };
    await enableBrowserReplica('owner', 'server', network);
    const runtime = browserReplica()!; runtime.pause();
    failAt = identityCalls + 2;
    await expect(enableBrowserReplica('owner', 'server', network)).rejects.toThrow('temporary outage');
    expect(runtime.needsRecovery).toBe(true);
    await edit(runtime, { title: '凭据更新仍然保留的离线修改' });
    const opId = (await runtime.status())!.outbox[0].opId;
    await runtime.store.update(runtime.scope, state => ({ state: { ...state!, token: 'revoked', authenticatedAt: 1 }, value: undefined }));
    await enableBrowserReplica('owner', 'server', network);
    expect(runtime.needsRecovery).toBe(false);
    expect((await runtime.status())!.authenticatedAt).toBeGreaterThan(1);
    expect(remote.receipts.has(opId)).toBe(true); expect(remote.tasks.task.title).toBe('凭据更新仍然保留的离线修改');
    expect((await runtime.status())!.outbox).toHaveLength(0); expect(pairs).toBe(2);
  });
});
