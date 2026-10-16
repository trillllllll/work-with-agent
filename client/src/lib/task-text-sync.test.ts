import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { TaskDraftStore } from './task-draft-store.js';
import { TaskTextSyncCoordinator, type TransportOutcome, type TransportRequest } from './task-text-sync.js';
import { createWriteQueue } from './todo.js';
import type { TaskTextDraftV1, TextVersion } from './task-editor-types.js';

class ManualClock {
  time = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  now = () => this.time;

  schedule = (fn: () => void, ms: number) => {
    const timer = { at: this.time + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  };

  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }
}

type Pending = { request: TransportRequest; resolve: (outcome: TransportOutcome) => void };

class TestTransport {
  sent: TransportRequest[] = [];
  pending: Pending[] = [];
  private active = new Map<string, number>();
  maxActivePerPath = new Map<string, number>();

  send = async (request: TransportRequest): Promise<TransportOutcome> => {
    this.sent.push({ ...request });
    const count = (this.active.get(request.path) ?? 0) + 1;
    this.active.set(request.path, count);
    this.maxActivePerPath.set(request.path, Math.max(this.maxActivePerPath.get(request.path) ?? 0, count));
    return new Promise<TransportOutcome>((resolve) => {
      this.pending.push({ request, resolve: (outcome) => { this.active.set(request.path, (this.active.get(request.path) ?? 1) - 1); resolve(outcome); } });
    });
  };

  succeed(index: number, task: { revision: number; title: string; description: string }) {
    const entry = this.pending[index];
    if (!entry) throw new Error(`没有第 ${index} 个待回包请求`);
    entry.resolve({ kind: 'success', status: 200, body: { data: task } });
  }

  fail(index: number, outcome: TransportOutcome) {
    const entry = this.pending[index];
    if (!entry) throw new Error(`没有第 ${index} 个待回包请求`);
    entry.resolve(outcome);
  }
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function until(condition: () => boolean, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

const scopeKey = '["http://app","http://app","u1"]';
const base: TextVersion = { revision: 1, title: '标题', description: '' };

async function setup(options: { store?: TaskDraftStore; remoteTasks?: Record<string, TextVersion>; authed?: boolean } = {}) {
  const store = options.store ?? new TaskDraftStore(new IDBFactory());
  const clock = new ManualClock();
  const transport = new TestTransport();
  const remoteTasks = options.remoteTasks ?? {};
  let authed = options.authed ?? true;
  let ids = 0;
  const coordinator = new TaskTextSyncCoordinator({
    scopeKey,
    store,
    send: transport.send,
    now: clock.now,
    schedule: clock.schedule,
    enqueue: createWriteQueue(),
    newRequestId: () => `req-${++ids}`,
    fetchTaskText: async (taskId) => remoteTasks[taskId] ?? null,
    isAuthed: () => authed,
  });
  return {
    coordinator, store, clock, transport,
    setAuthed: (value: boolean) => { authed = value; },
    open: (taskId = 'task-1', version: TextVersion = base) => coordinator.openTask(taskId, version),
    edit: (description: string, taskId = 'task-1', title = '标题') => coordinator.onUserEdit(taskId, { title, description }),
  };
}

describe('TaskTextSyncCoordinator', () => {
  it('重新订阅时立刻收到内存中的未同步草稿', async () => {
    const { coordinator, open, edit } = await setup();
    await open();
    edit('', 'task-1', '未保存的新标题');
    await flush();
    let title: string | null = null;
    const stop = coordinator.subscribe('task-1', (event) => { title = event.record?.draft.title ?? null; });
    expect(title).toBe('未保存的新标题');
    stop();
    coordinator.dispose();
  });

  it('打开完成前的输入在记录创建后仍保留', async () => {
    const { coordinator } = await setup();
    const opening = coordinator.openTask('task-1', base);
    coordinator.onUserEdit('task-1', { title: '抢先输入', description: '' });
    await opening;
    await flush();
    expect(coordinator.getRecord('task-1')?.draft.title).toBe('抢先输入');
    coordinator.dispose();
  });

  it('输入后 1999ms 网络发送次数为 0；2000ms 且本地事务完成后恰好发送一次', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('hello');
    clock.advance(1999);
    await flush();
    expect(transport.sent).toHaveLength(0);

    clock.advance(1);
    expect(await until(() => transport.sent.length === 1)).toBe(true);
    expect(JSON.parse(transport.sent[0].bodyJson)).toEqual({ expectedRevision: 1, description: 'hello' });
    expect(transport.sent[0].path).toBe('/api/tasks/task-1');
    expect(transport.sent[0].method).toBe('PATCH');
    coordinator.dispose();
  });

  it('连续输入重置计时，只提交最后一次输入的完整文字', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('A');
    clock.advance(1500);
    edit('AB');
    clock.advance(1999);
    await flush();
    expect(transport.sent).toHaveLength(0);
    clock.advance(1);
    expect(await until(() => transport.sent.length === 1)).toBe(true);
    expect(JSON.parse(transport.sent[0].bodyJson)).toEqual({ expectedRevision: 1, description: 'AB' });
    coordinator.dispose();
  });

  it('saveNow（标题失焦）取消防抖立即发送', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('blur save');
    clock.advance(100);
    coordinator.saveNow('task-1');
    await flush();
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    // 已取消的防抖计时不能再触发第二次发送。
    clock.advance(10_000);
    await flush();
    expect(transport.sent).toHaveLength(1);
    expect(JSON.parse(transport.sent[0].bodyJson)).toEqual({ expectedRevision: 1, description: 'blur save' });
    coordinator.dispose();
  });

  it('持续输入无停顿时，最长等待 10 秒落一次检查点', async () => {
    const { coordinator, clock, transport, open } = await setup();
    await open();
    // 每 1500ms 输入一次，任何两次之间都不到 2000ms 防抖阈值；
    // 纯防抖下不应有任何发送，请求只能来自 10s 检查点。
    for (let index = 0; index < 7; index += 1) {
      coordinator.onUserEdit('task-1', { title: '标题', description: `draft-${index}` });
      clock.advance(1500);
    }
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    expect(JSON.parse(transport.sent[0].bodyJson)).toEqual({ expectedRevision: 1, description: 'draft-6' });
    clock.advance(10_000);
    await flush();
    expect(transport.sent).toHaveLength(1);
    coordinator.dispose();
  });

  it('检查点保存被确认后重开等待窗口，不会每次 ACK 都立刻再发', async () => {
    const { coordinator, clock, transport, open } = await setup();
    await open();
    for (let index = 0; index < 7; index += 1) {
      coordinator.onUserEdit('task-1', { title: '标题', description: `draft-${index}` });
      clock.advance(1500);
    }
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.succeed(0, { revision: 2, title: '标题', description: 'draft-6' });
    await flush();
    // ACK 后继续输入：等待窗口从 ACK 时刻重开，仍按防抖节奏保存。
    coordinator.onUserEdit('task-1', { title: '标题', description: 'more' });
    clock.advance(1999);
    await flush();
    expect(transport.sent).toHaveLength(1);
    clock.advance(1);
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    coordinator.dispose();
  });

  it('输入高频路径的本地持久化按 250ms 节流，关键路径先冲刷', async () => {
    const realStore = new TaskDraftStore(new IDBFactory());
    let puts = 0;
    const counted = Object.assign(Object.create(Object.getPrototypeOf(realStore)), realStore, {
      put: (record: TaskTextDraftV1) => { puts += 1; return realStore.put(record); },
    });
    const { coordinator, clock, transport, open } = await setup({ store: counted });
    await open();
    await flush();
    const baseline = puts;
    for (let index = 0; index < 5; index += 1) coordinator.onUserEdit('task-1', { title: '标题', description: `d-${index}` });
    await flush();
    expect(puts).toBe(baseline);
    clock.advance(250);
    await flush();
    expect(puts).toBe(baseline + 1);
    const persisted = await realStore.load(scopeKey, 'task-1');
    expect(persisted[0]?.draft.description).toBe('d-4');
    // 节流挂起时进入关键路径（发请求）会先冲刷，再带 outbox 写一次。
    coordinator.onUserEdit('task-1', { title: '标题', description: 'd-5' });
    coordinator.saveNow('task-1');
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    expect(puts).toBeGreaterThanOrEqual(baseline + 3);
    coordinator.dispose();
  });

  it('本地 put 成功、事务尚未完成时状态不是已存本地，也不发请求', async () => {
    const held = new TaskDraftStore(new IDBFactory());
    // 持久化停在事务中间：put 永不完成（transaction.oncomplete 不到来）。
    const slowStore = Object.assign(Object.create(Object.getPrototypeOf(held)), held, {
      put: () => new Promise<void>(() => {}),
    });
    const { coordinator, clock, transport, open } = await setup({ store: slowStore });
    await open();
    coordinator.onUserEdit('task-1', { title: '标题', description: 'hello' });
    clock.advance(2000);
    await flush();
    expect(transport.sent).toHaveLength(0);
    expect(coordinator.status('task-1')).toBe('local-pending');
    coordinator.dispose();
  });

  it('本地事务 abort 后 prepareLeave 返回 false，网络发送次数为 0', async () => {
    const failing = new TaskDraftStore(new IDBFactory());
    const failingStore = Object.assign(Object.create(Object.getPrototypeOf(failing)), failing, {
      put: () => Promise.reject(new Error('transaction aborted')),
    });
    const { coordinator, clock, transport, open } = await setup({ store: failingStore });
    await open();
    coordinator.onUserEdit('task-1', { title: '标题', description: 'hello' });
    clock.advance(2000);
    await flush();
    expect(transport.sent).toHaveLength(0);
    expect(coordinator.status('task-1')).toBe('storage-error');
    await expect(coordinator.prepareLeave('task-1')).resolves.toBe(false);
    expect(transport.sent).toHaveLength(0);
    coordinator.dispose();
  });

  it('首次请求超时后，重试的 requestId 与 bodyJson 与首次逐字相同', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('hello');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.fail(0, { kind: 'network' });
    await flush();
    clock.advance(2_000);
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    expect(transport.sent[1].requestId).toBe(transport.sent[0].requestId);
    expect(transport.sent[1].bodyJson).toBe(transport.sent[0].bodyJson);
    coordinator.dispose();
  });

  it('旧请求发送 A、期间输入 AB：ACK 后草稿保持 AB，随后按新版本提交 AB', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('A');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    edit('AB');
    transport.succeed(0, { revision: 2, title: '标题', description: 'A' });
    await flush();
    expect(coordinator.getRecord('task-1')?.draft.description).toBe('AB');
    expect(coordinator.getRecord('task-1')?.base.description).toBe('A');
    clock.advance(2000);
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    expect(JSON.parse(transport.sent[1].bodyJson)).toEqual({ expectedRevision: 2, description: 'AB' });
    coordinator.dispose();
  });

  it('同一任务两个保存的最大并发数为 1；不同任务各自请求路径与草稿 taskId 一致', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    await coordinator.openTask('task-2', { revision: 4, title: '乙', description: '' });
    edit('one');
    coordinator.onUserEdit('task-2', { title: '乙', description: 'two' });
    void coordinator.ensureSaved('task-1');
    void coordinator.ensureSaved('task-1');
    clock.advance(0);
    await flush();
    void coordinator.ensureSaved('task-2');
    await flush();
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    expect(transport.maxActivePerPath.get('/api/tasks/task-1')).toBe(1);
    expect(transport.maxActivePerPath.get('/api/tasks/task-2')).toBe(1);
    const paths = transport.sent.map((request) => request.path).sort();
    expect(paths).toEqual(['/api/tasks/task-1', '/api/tasks/task-2']);
    expect(coordinator.getRecord('task-1')?.taskId).toBe('task-1');
    expect(coordinator.getRecord('task-2')?.taskId).toBe('task-2');
    coordinator.dispose();
  });

  it('离开详情后旧请求返回，不修改当前新任务的正文', async () => {
    const { coordinator, clock, transport, open, edit } = await setup();
    await open();
    edit('old');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    await coordinator.openTask('task-2', { revision: 1, title: '乙', description: '' });
    coordinator.onUserEdit('task-2', { title: '乙', description: 'new' });
    // task-1 的迟到的成功回包到达。
    transport.succeed(0, { revision: 2, title: '标题', description: 'old' });
    await flush();
    expect(coordinator.getRecord('task-2')?.draft.description).toBe('new');
    expect(coordinator.getRecord('task-1')?.draft.description).toBe('old');
    expect(coordinator.getRecord('task-1')?.base.revision).toBe(2);
    // 分支被放弃后，再迟到的重复回包不会复活记录。
    await coordinator.discardBranch('task-1');
    transport.fail(0, { kind: 'network' });
    await flush();
    expect(coordinator.getRecord('task-1')).toBeNull();
    coordinator.dispose();
  });

  it('网络断开后切换任务：prepareLeave 为 true，原草稿仍在 IndexedDB', async () => {
    const { coordinator, store, clock, transport, open, edit } = await setup();
    await open();
    edit('offline draft');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.fail(0, { kind: 'network' });
    await flush();
    await expect(coordinator.prepareLeave('task-1')).resolves.toBe(true);
    const records = await store.load(scopeKey, 'task-1');
    expect(records).toHaveLength(1);
    expect(records[0].draft.description).toBe('offline draft');
    coordinator.dispose();
  });

  it('远端冲突时不自动覆盖 PATCH，保留三份字段值', async () => {
    const { coordinator, clock, transport, open, edit } = await setup({
      remoteTasks: { 'task-1': { revision: 3, title: '标题', description: 'remote text' } },
    });
    await open();
    edit('local text');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.fail(0, { kind: 'rejected', status: 409, code: 'VERSION_CONFLICT', body: {} });
    await flush();
    const record = coordinator.getRecord('task-1');
    expect(record?.conflicts.description).toEqual({
      base: '',
      local: 'local text',
      remote: 'remote text',
      remoteRevision: 3,
    });
    expect(coordinator.status('task-1')).toBe('conflict');
    clock.advance(60_000);
    await flush();
    expect(transport.sent).toHaveLength(1);
    // 用户选择“使用我的内容”后才以远端版本为基线正常提交。
    coordinator.resolveConflictsKeepMine('task-1');
    clock.advance(0);
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    expect(JSON.parse(transport.sent[1].bodyJson)).toEqual({ expectedRevision: 3, description: 'local text' });
    coordinator.dispose();
  });

  it('标题 trim 后为空：无文字 PATCH，本地草稿保留', async () => {
    const { coordinator, clock, transport, store, open } = await setup();
    await open();
    coordinator.onUserEdit('task-1', { title: '   ', description: 'kept' });
    clock.advance(5_000);
    await flush();
    expect(transport.sent).toHaveLength(0);
    expect(coordinator.getRecord('task-1')?.blockedReason).toBe('invalid-title');
    const records = await store.load(scopeKey, 'task-1');
    expect(records[0]?.draft).toEqual({ title: '   ', description: 'kept' });
    coordinator.dispose();
  });

  it('401 后不再定时重试，重新认证后才恢复', async () => {
    const { coordinator, setAuthed, clock, transport, open, edit } = await setup();
    await open();
    edit('secret');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.fail(0, { kind: 'rejected', status: 401, code: 'AUTH_REQUIRED', body: {} });
    await flush();
    expect(coordinator.getRecord('task-1')?.blockedReason).toBe('auth');
    clock.advance(120_000);
    await flush();
    expect(transport.sent).toHaveLength(1);
    setAuthed(true);
    coordinator.setAuthenticated(true);
    clock.advance(0);
    expect(await until(() => transport.sent.length === 2)).toBe(true);
    expect(JSON.parse(transport.sent[1].bodyJson)).toEqual({ expectedRevision: 1, description: 'secret' });
    coordinator.dispose();
  });

  it('404 后不复活任务，草稿仍可查看', async () => {
    const { coordinator, clock, transport, store, open, edit } = await setup();
    await open();
    edit('gone');
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.fail(0, { kind: 'rejected', status: 404, code: 'NOT_FOUND', body: {} });
    await flush();
    expect(coordinator.getRecord('task-1')?.blockedReason).toBe('not-found');
    clock.advance(60_000);
    await flush();
    expect(transport.sent).toHaveLength(1);
    const records = await store.load(scopeKey, 'task-1');
    expect(records[0]?.draft.description).toBe('gone');
    coordinator.dispose();
  });

  it('同 scope 同任务两个 branch 的草稿均保留，不互相覆盖', async () => {
    const { coordinator, store, open, edit } = await setup();
    await open();
    edit('window one');
    await flush();
    const other: TaskTextDraftV1 = {
      schemaVersion: 1,
      scopeKey,
      taskId: 'task-1',
      branchId: 'branch-other',
      recordVersion: 1,
      editSeq: 1,
      base,
      draft: { title: '标题', description: 'window two' },
      outbox: null,
      conflicts: {},
      blockedReason: null,
      retryCount: 0,
      nextRetryAt: null,
      updatedAt: 2,
    };
    await store.put(other);
    await store.put(coordinator.getRecord('task-1')!);
    const records = await store.load(scopeKey, 'task-1');
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.draft.description).sort()).toEqual(['window one', 'window two']);
    coordinator.dispose();
  });

  it('删除草稿时出现更新版本：条件删除失败，新版本仍存在', async () => {
    const store = new TaskDraftStore(new IDBFactory());
    const record: TaskTextDraftV1 = {
      schemaVersion: 1,
      scopeKey: 's', taskId: 'task-1', branchId: 'b',
      recordVersion: 4, editSeq: 1,
      base, draft: { title: '标题', description: '' },
      outbox: null, conflicts: {}, blockedReason: null,
      retryCount: 0, nextRetryAt: null, updatedAt: 1,
    };
    await store.put(record);
    // 用户继续输入，版本前进到 5。
    await store.put({ ...record, recordVersion: 5, draft: { title: '标题', description: 'newer' } });
    const deleted = await store.deleteIfResolved('s', 'task-1', 'b', { recordVersion: 4, outboxEmpty: true, text: record.draft });
    expect(deleted).toBe(false);
    const remaining = await store.load('s', 'task-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].recordVersion).toBe(5);
    expect(remaining[0].draft.description).toBe('newer');
  });

  it('页面重载后先重放原 outbox 请求，不重新生成 ID', async () => {
    const harness = await setup();
    await harness.open();
    harness.edit('replay me');
    harness.clock.advance(2000);
    expect(await until(() => harness.transport.pending.length === 1)).toBe(true);
    const original = harness.transport.sent[0];
    harness.coordinator.dispose();

    // 新窗口：同一 scope、同一 IndexedDB，显式恢复旧分支。
    const store = harness.store;
    const clock = new ManualClock();
    const transport = new TestTransport();
    let ids = 100;
    const rebooted = new TaskTextSyncCoordinator({
      scopeKey,
      store,
      send: transport.send,
      now: clock.now,
      schedule: clock.schedule,
      enqueue: createWriteQueue(),
      newRequestId: () => `req-${++ids}`,
      fetchTaskText: async () => null,
      isAuthed: () => true,
    });
    await rebooted.restoreBranch('task-1', harness.coordinator.branchId);
    clock.advance(0);
    expect(await until(() => transport.sent.length === 1)).toBe(true);
    expect(transport.sent[0].requestId).toBe(original.requestId);
    expect(transport.sent[0].bodyJson).toBe(original.bodyJson);
    expect(transport.sent[0].path).toBe(original.path);
    rebooted.dispose();
  });

  it('保存成功后草稿按条件清理；中文组词期间不触发远端保存', async () => {
    const { coordinator, clock, transport, store, open } = await setup();
    await open();
    coordinator.setComposing('task-1', true);
    coordinator.onUserEdit('task-1', { title: '标题', description: '组词中' });
    clock.advance(5_000);
    await flush();
    expect(transport.sent).toHaveLength(0);
    coordinator.setComposing('task-1', false);
    clock.advance(2000);
    expect(await until(() => transport.pending.length === 1)).toBe(true);
    transport.succeed(0, { revision: 2, title: '标题', description: '组词中' });
    await flush();
    expect(coordinator.status('task-1')).toBe('clean');
    let cleaned = false;
    for (let i = 0; i < 60 && !cleaned; i += 1) {
      cleaned = (await store.load(scopeKey, 'task-1')).length === 0;
      if (!cleaned) await new Promise((resolve) => setImmediate(resolve));
    }
    expect(cleaned).toBe(true);
    coordinator.dispose();
  });
});
