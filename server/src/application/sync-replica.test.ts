import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma, sqliteConnectionUrl } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { DomainError } from '../domain/task.js';
import { isCompleteSyncRow, syncFields, type SyncRow } from './sync-merge.js';
import { listBaselineRows, readSyncSnapshot, offerBaselineRows, pairSyncDevice, pullSyncOps, pushSyncOps, readLive, writeLive } from './sync-log.js';
import { localSchemaVersion } from './snapshots.js';
import { alignReplica, assertSyncUrl, readSyncBinding, recordCommittedGroup, runReplicaCycle, writeSyncBinding, type ReplicaTransport } from './sync-replica.js';

const require = createRequire(import.meta.url);
const serverRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const replicaDir = mkdtempSync(join(tmpdir(), 'wwa-replica-'));
const replicaUrl = `file:${join(replicaDir, 'replica.db')}`;
const hubSecret = 'hub-secret-not-in-sync';
const replicaSecret = 'replica-secret-not-in-sync';
const ids = { hubTopic: 'topic-hub-align-1', replicaTopic: 'topic-replica-align-1', hubOnly: 'task-hub-only-1', replicaOnly: 'task-replica-only-1', shared: 'task-shared-align-1' };
const deviceIds: string[] = [];
let replica: PrismaClient;
let transport: ReplicaTransport;

function filled(entity: 'task' | 'topic', patch: Record<string, unknown>): SyncRow {
  const row: SyncRow = {};
  for (const field of syncFields[entity]) row[field] = field === 'tagIds' ? [] : field === 'completedAtEstimated' ? false : null;
  if (entity === 'task') Object.assign(row, { title: '', description: '', status: 'todo', priority: 'none', resultSummary: '', recurrenceRule: '', sortOrder: 0 });
  else Object.assign(row, { name: '', description: '', color: 'slate', isExploration: false, goal: '', draftSummary: '', finalSummary: '', summaryStatus: 'empty' });
  return { ...row, ...patch };
}

async function canonical(db: PrismaClient, entity: 'task' | 'topic', id: string) {
  return db.$transaction(async (tx) => (await readLive(tx, entity, id)).row);
}

describe('replica alignment', () => {
  beforeAll(async () => {
    const hubUrl = process.env.DATABASE_URL ?? '';
    if (!hubUrl.includes('sync-phase1') && !hubUrl.includes('test.db')) throw new Error(`refusing to write the workspace database at ${hubUrl}`);
    // Prisma's schema engine requires the SQLite file to exist on this platform.
    writeFileSync(join(replicaDir, 'replica.db'), '', { flag: 'a' });
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: replicaUrl },
      stdio: 'pipe',
    });
    replica = new PrismaClient({ datasourceUrl: sqliteConnectionUrl(replicaUrl) });
    const paired = await pairSyncDevice('replica-test');
    const phone = await pairSyncDevice('phone-test');
    deviceIds.push(paired.deviceId, phone.deviceId);
    const schemaVersion = localSchemaVersion();
    transport = {
      push: (body) => pushSyncOps(paired.deviceId, body),
      pull: (after, limit) => pullSyncOps(after, limit),
      rows: (entity, afterId, limit) => listBaselineRows(entity, afterId, limit),
      offer: (entity, rows) => offerBaselineRows(paired.deviceId, schemaVersion, entity, rows),
    };
  }, 60_000);

  afterAll(async () => {
    const taskIds = [ids.hubOnly, ids.replicaOnly, ids.shared, 'a-child-sync-test', 'z-parent-sync-test', 'private-obsolete-cache'];
    const topicIds = [ids.hubTopic, ids.replicaTopic];
    await prisma.syncConflict.deleteMany({ where: { entityId: { in: [...taskIds, ...topicIds] } } });
    await prisma.syncOp.deleteMany({ where: { entityId: { in: [...taskIds, ...topicIds] } } });
    await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.updateMany({ where: { id: { in: taskIds } }, data: { parentId: null } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
    await prisma.syncReceipt.deleteMany();
    await prisma.syncDevice.deleteMany({ where: { id: { in: deviceIds } } });
    const setting = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    if (setting?.openaiApiKey === hubSecret) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiApiKey: '' } });
    await replica?.$disconnect();
    rmSync(replicaDir, { recursive: true, force: true });
  });

  it('accepts https and loopback http only', () => {
    expect(assertSyncUrl('https://wwa.example.com/workspace')).toBe('https://wwa.example.com');
    expect(assertSyncUrl('http://127.0.0.1:3016/api')).toBe('http://127.0.0.1:3016');
    expect(() => assertSyncUrl('http://10.1.1.1')).toThrow(/https/);
  });

  it('stores a credential outside the database', () => {
    const previous = process.env.DOVUN_DATA_DIR;
    const directory = mkdtempSync(join(tmpdir(), 'wwa-sync-bind-'));
    process.env.DOVUN_DATA_DIR = directory;
    try {
      writeSyncBinding({ url: 'https://wwa.example.com', token: 'a'.repeat(32) });
      expect(readSyncBinding()?.url).toBe('https://wwa.example.com');
      expect(statSync(join(directory, 'sync-device.json')).mode & 0o777).toBe(0o600);
      expect(readSyncBinding()?.token).toBe('a'.repeat(32));
    } finally {
      if (previous === undefined) delete process.env.DOVUN_DATA_DIR;
      else process.env.DOVUN_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aligns both sides, then merges fields and keeps a same-field conflict', async () => {
    expect((await request(app).get('/api/v1/sync/baseline/rows?entity=task')).status).toBe(401);
    const session = await ownerSession(app);
    const previousData = process.env.DOVUN_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'wwa-sync-status-'));
    process.env.DOVUN_DATA_DIR = dataDir;
    try {
      expect((await request(app).get('/api/v1/sync/status').set('Cookie', session.cookie)).body.data.bound).toBe(false);
    } finally {
      if (previousData === undefined) delete process.env.DOVUN_DATA_DIR;
      else process.env.DOVUN_DATA_DIR = previousData;
      rmSync(dataDir, { recursive: true, force: true });
    }
    const stamp = new Date().toISOString();
    await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: hubSecret, createdAt: stamp, updatedAt: stamp }, update: { openaiApiKey: hubSecret } });
    await replica.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: replicaSecret, createdAt: stamp, updatedAt: stamp }, update: { openaiApiKey: replicaSecret } });
    await prisma.$transaction(async (tx) => {
      await writeLive(tx, 'topic', ids.hubTopic, filled('topic', { name: '服务器清单' }));
      await writeLive(tx, 'task', ids.hubOnly, filled('task', { title: '只在服务器', topicId: ids.hubTopic }));
      await writeLive(tx, 'task', ids.shared, filled('task', { title: '服务器标题' }));
    });
    await replica.$transaction(async (tx) => {
      await writeLive(tx, 'topic', ids.replicaTopic, filled('topic', { name: '本机清单' }));
      await writeLive(tx, 'task', ids.replicaOnly, filled('task', { title: '只在本机', topicId: ids.replicaTopic }));
      await writeLive(tx, 'task', ids.shared, filled('task', { title: '本机标题' }));
    });

    const aligned = await alignReplica(replica, { ...transport, snapshot: readSyncSnapshot });
    expect(aligned.already).toBe(false);
    expect((await canonical(replica, 'task', ids.hubOnly))?.title).toBe('只在服务器');
    expect((await canonical(replica, 'task', ids.hubOnly))?.topicId).toBe(ids.hubTopic);
    expect((await canonical(prisma, 'task', ids.replicaOnly))?.title).toBe('只在本机');
    expect((await canonical(prisma, 'task', ids.replicaOnly))?.topicId).toBe(ids.replicaTopic);
    expect((await canonical(prisma, 'task', ids.shared))?.title).toBe('服务器标题');
    expect((await canonical(replica, 'task', ids.shared))?.title).toBe('服务器标题');
    const conflict = await prisma.syncConflict.findFirst({ where: { entityId: ids.shared, field: 'title', state: 'pending' } });
    expect(JSON.parse(conflict?.incomingJson ?? 'null')).toBe('本机标题');
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).openaiApiKey).toBe(hubSecret);
    expect((await replica.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).openaiApiKey).toBe(replicaSecret);
    expect(JSON.stringify(await transport.pull(0, 20))).not.toContain(hubSecret);

    const base = await canonical(prisma, 'task', ids.hubOnly);
    await pushSyncOps(deviceIds[1], { schemaVersion: localSchemaVersion(), ops: [{ opId: 'phone-title-change-01', entityType: 'task', entityId: ids.hubOnly, before: base, after: { ...base, title: '手机标题' } }] });
    await replica.syncOutbox.create({ data: { opId: 'desk-desc-change-01', entityType: 'task', entityId: ids.hubOnly, beforeJson: JSON.stringify(base), afterJson: JSON.stringify({ ...base, description: '本机补充' }), state: 'pending', createdAt: stamp } });
    await runReplicaCycle(replica, transport);
    expect((await canonical(prisma, 'task', ids.hubOnly))?.title).toBe('手机标题');
    expect((await canonical(prisma, 'task', ids.hubOnly))?.description).toBe('本机补充');
    expect((await canonical(replica, 'task', ids.hubOnly))?.title).toBe('手机标题');
    expect((await canonical(replica, 'task', ids.hubOnly))?.description).toBe('本机补充');

    const base2 = await canonical(prisma, 'task', ids.hubOnly);
    await pushSyncOps(deviceIds[1], { schemaVersion: localSchemaVersion(), ops: [{ opId: 'phone-title-change-02', entityType: 'task', entityId: ids.hubOnly, before: base2, after: { ...base2, title: '先到' } }] });
    await replica.syncOutbox.create({ data: { opId: 'desk-title-change-02', entityType: 'task', entityId: ids.hubOnly, beforeJson: JSON.stringify(base2), afterJson: JSON.stringify({ ...base2, title: '后到' }), state: 'pending', createdAt: stamp } });
    await runReplicaCycle(replica, transport);
    expect((await canonical(prisma, 'task', ids.hubOnly))?.title).toBe('先到');
    expect((await canonical(replica, 'task', ids.hubOnly))?.title).toBe('先到');
    expect((await canonical(replica, 'task', ids.hubOnly))?.description).toBe('本机补充');
    const later = await prisma.syncConflict.findFirst({ where: { entityId: ids.hubOnly, field: 'title', state: 'pending' } });
    expect(JSON.parse(later?.incomingJson ?? 'null')).toBe('后到');
    const duplicate = await transport.push({ schemaVersion: localSchemaVersion(), ops: [{ opId: 'phone-title-change-02', entityType: 'task', entityId: ids.hubOnly, before: base2, after: { ...base2, title: '先到' } }] });
    expect(duplicate.results[0].status).toBe('duplicate');
    expect(await prisma.task.count({ where: { id: ids.hubOnly } })).toBe(1);

    const queuedBefore = await replica.syncOutbox.count({ where: { opId: { startsWith: 'change-enqueue-1' } } });
    expect(queuedBefore).toBe(0);
    const previousUrl = process.env.DOVUN_SYNC_URL;
    const previousToken = process.env.DOVUN_SYNC_TOKEN;
    process.env.DOVUN_SYNC_URL = 'https://wwa.example.com';
    process.env.DOVUN_SYNC_TOKEN = 'b'.repeat(32);
    try {
      await replica.$transaction(async (tx) => {
        await recordCommittedGroup(tx, 'change-enqueue-1', { entities: { tasks: { [ids.replicaOnly]: null }, topics: {}, tags: {} } }, { entities: { tasks: { [ids.replicaOnly]: await readLive(tx, 'task', ids.replicaOnly).then((item) => item.row) }, topics: {}, tags: {} } });
      });
    } finally {
      if (previousUrl === undefined) delete process.env.DOVUN_SYNC_URL;
      else process.env.DOVUN_SYNC_URL = previousUrl;
      if (previousToken === undefined) delete process.env.DOVUN_SYNC_TOKEN;
      else process.env.DOVUN_SYNC_TOKEN = previousToken;
    }
    expect(await replica.syncOutbox.count({ where: { opId: { startsWith: 'change-enqueue-1:' } } })).toBe(1);
  }, 30_000);

  it('propagates a hub-side recurring completion and its spawned occurrence to the replica in one cycle', async () => {
    const session = await ownerSession(app);
    const created = await request(app).post('/api/tasks').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ title: '同步周报', dueDate: '2026-10-20', recurrenceRule: '{"unit":"week","step":1}' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const originId = created.body.data.id as string;
    expect((await canonical(prisma, 'task', originId))?.recurrenceRule).toBe('{"unit":"week","step":1}');
    await runReplicaCycle(replica, transport);
    expect((await canonical(replica, 'task', originId))?.recurrenceRule).toBe('{"unit":"week","step":1}');

    let done = await request(app).patch(`/api/tasks/${originId}`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ status: 'done', expectedRevision: created.body.data.revision });
    if (done.status === 428) {
      const preview = await request(app).post('/api/v1/commands/preview').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ commands: done.body.details.commands });
      done = await request(app).patch(`/api/tasks/${originId}`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ status: 'done', expectedRevision: created.body.data.revision, previewToken: preview.body.data.previewToken });
    }
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const nextId = (done.body.meta.affectedTaskIds as string[]).find((id) => id !== originId)!;
    expect(nextId).toBeTruthy();

    await runReplicaCycle(replica, transport);
    expect((await canonical(replica, 'task', originId))?.status).toBe('done');
    const next = await canonical(replica, 'task', nextId);
    expect(next).toMatchObject({ title: '同步周报', status: 'todo', dueDate: '2026-10-27', recurrenceRule: '{"unit":"week","step":1}' });
    try {
      // syncOp rows stay: deleting them would punch gaps into the shared hub log and
      // break seq-contiguity validation for every later test. afterAll scrubs them.
      await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: [originId, nextId] } } });
      await prisma.changeRecord.deleteMany({ where: { OR: [{ entityId: originId }, { beforeSnapshot: { contains: originId } }, { afterSnapshot: { contains: originId } }] } });
      await prisma.task.deleteMany({ where: { id: { in: [originId, nextId] } } });
    } catch { /* best-effort fixture cleanup; afterAll scrubs the shared ids */ }
  }, 30_000);
  async function pendingFixture() {
    await replica.syncOutbox.deleteMany();
    await replica.syncState.upsert({ where: { id: 'local' }, create: { id: 'local', baselineReady: true, appliedHubSeq: 0, updatedAt: new Date().toISOString() }, update: { baselineReady: true, appliedHubSeq: 0 } });
    await replica.syncOutbox.create({ data: { opId: 'protocol-pending-01', entityType: 'task', entityId: ids.hubOnly, beforeJson: null, afterJson: JSON.stringify(filled('task', { title: '必须保留的本机修改' })), state: 'pending', createdAt: new Date().toISOString() } });
  }

  it.each(['missing', 'foreign', 'duplicate', 'unconfirmed'])('keeps pending changes when the push receipt is %s', async (kind) => {
    await pendingFixture();
    const ack = { opId: 'protocol-pending-01', status: 'applied', seq: null, landed: null };
    const results = kind === 'missing' ? [] : kind === 'foreign' ? [{ ...ack, opId: 'not-in-this-batch' }] : kind === 'duplicate' ? [ack, ack] : [{ ...ack, status: 'pending' }];
    const invalid: ReplicaTransport = { ...transport, push: async () => ({ tip: 0, results }), pull: async () => ({ tip: 0, schemaVersion: localSchemaVersion(), ops: [] }) };
    await expect(runReplicaCycle(replica, invalid)).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_ERROR' });
    expect((await replica.syncOutbox.findUniqueOrThrow({ where: { opId: ack.opId } })).state).toBe('pending');
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).appliedHubSeq).toBe(0);
  });

  it('does not skip an unsupported entity and advance the pull cursor', async () => {
    await pendingFixture(); await replica.syncOutbox.deleteMany();
    const invalid: ReplicaTransport = { ...transport, pull: async () => ({ tip: 1, schemaVersion: localSchemaVersion(), ops: [{ seq: 1, opId: 'unknown-entity-01', entityType: 'future-entity', entityId: 'unknown', before: null, after: null }] }) };
    await expect(runReplicaCycle(replica, invalid)).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_ERROR' });
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).appliedHubSeq).toBe(0);
  });

  it.each([{ tip: 0, seqs: [1] }, { tip: 2, seqs: [2, 1] }, { tip: 2, seqs: [2] }, { tip: 3, seqs: [1, 3] }])('validates a whole pull page before applying it: %j', async ({ tip, seqs }) => {
    await pendingFixture(); await replica.syncOutbox.deleteMany();
    const before = await canonical(replica, 'task', ids.hubOnly);
    const invalid: ReplicaTransport = { ...transport, pull: async () => ({ tip, schemaVersion: localSchemaVersion(), ops: seqs.map((seq, index) => ({ seq, opId: `bad-page-op-${index}`, entityType: 'task', entityId: ids.hubOnly, before, after: { ...before, title: '不得落库的响应' } })) }) };
    await expect(runReplicaCycle(replica, invalid)).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_ERROR' });
    expect(await canonical(replica, 'task', ids.hubOnly)).toEqual(before);
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).appliedHubSeq).toBe(0);
  });

  it('keeps queued changes when initial alignment cannot reach the server', async () => {
    await pendingFixture(); await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false } });
    const offline: ReplicaTransport = { ...transport, pull: async () => { throw new Error('offline'); } };
    await expect(alignReplica(replica, offline)).rejects.toThrow('offline');
    expect((await replica.syncOutbox.findUniqueOrThrow({ where: { opId: 'protocol-pending-01' } })).state).toBe('pending');
  });

  it('queues committed local changes even before baseline alignment finishes', async () => {
    await pendingFixture(); await replica.syncOutbox.deleteMany();
    await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false } });
    const previousUrl = process.env.DOVUN_SYNC_URL, previousToken = process.env.DOVUN_SYNC_TOKEN;
    process.env.DOVUN_SYNC_URL = 'https://wwa.example.com'; process.env.DOVUN_SYNC_TOKEN = 'b'.repeat(32);
    try {
      await replica.$transaction(tx => recordCommittedGroup(tx, 'before-baseline-change', { entities: { tasks: {}, topics: {}, tags: {} } }, { entities: { tasks: { [ids.replicaOnly]: filled('task', { title: '对齐前的本机新增' }) }, topics: {}, tags: {} } }));
    } finally {
      if (previousUrl === undefined) delete process.env.DOVUN_SYNC_URL; else process.env.DOVUN_SYNC_URL = previousUrl;
      if (previousToken === undefined) delete process.env.DOVUN_SYNC_TOKEN; else process.env.DOVUN_SYNC_TOKEN = previousToken;
    }
    expect(await replica.syncOutbox.count({ where: { opId: { startsWith: 'before-baseline-change:' }, state: 'pending' } })).toBe(1);
  });

  it('drains a pre-migration outbox row by completing missing columns from the live row', async () => {
    await replica.syncOutbox.deleteMany();
    // A pending op persisted before a column-adding migration: its rows lack goalDueDate.
    const legacyTopic = { ...filled('topic', { name: '迁移前清单' }) } as SyncRow;
    delete (legacyTopic as Record<string, unknown>).goalDueDate;
    await replica.$transaction(async (tx) => {
      await writeLive(tx, 'topic', ids.replicaTopic, { ...legacyTopic, goalDueDate: '2026-12-31' });
      await tx.syncState.upsert({ where: { id: 'local' }, create: { id: 'local', baselineReady: true, appliedHubSeq: 0, updatedAt: new Date().toISOString() }, update: { baselineReady: true } });
      await tx.syncOutbox.create({ data: { opId: 'legacy-outbox-01', entityType: 'topic', entityId: ids.replicaTopic, beforeJson: null, afterJson: JSON.stringify(legacyTopic), state: 'pending', createdAt: new Date().toISOString() } });
    });
    const pushed: unknown[] = [];
    const strictHub: ReplicaTransport = {
      ...transport,
      push: async (body) => {
        for (const op of body.ops) {
          if (!isCompleteSyncRow(op.entityType as 'task' | 'topic' | 'tag', op.before) || !isCompleteSyncRow(op.entityType as 'task' | 'topic' | 'tag', op.after)) throw new DomainError('VALIDATION_ERROR', '同步内容的字段或类型无效', 400);
          pushed.push(op);
        }
        return transport.push(body);
      },
    };
    await runReplicaCycle(replica, strictHub);
    expect(pushed).toHaveLength(1);
    expect((pushed[0] as { after: SyncRow }).after).toMatchObject({ name: '迁移前清单', goalDueDate: '2026-12-31' });
    expect((await replica.syncOutbox.findUniqueOrThrow({ where: { opId: 'legacy-outbox-01' } })).state).toBe('acked');
  });

  it('serializes a manual alignment and timer cycle on the same database', async () => {
    await pendingFixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const calls: string[] = [];
    const blocked: ReplicaTransport = { ...transport,
      push: async body => { calls.push('push'); started(); await gate; return { tip: 0, results: body.ops.map(op => ({ opId: op.opId, status: 'applied', seq: null, landed: op.after })) }; },
      pull: async () => { calls.push('pull'); return { tip: 0, schemaVersion: localSchemaVersion(), ops: [] }; },
    };
    const first = runReplicaCycle(replica, blocked);
    await entered;
    const second = alignReplica(replica, blocked);
    expect(calls).toEqual(['push']);
    release();
    await first; await second;
    expect(calls).toEqual(['push', 'pull']);
  });

  it('preserves an edit made while the initial offer is in flight', async () => {
    await replica.syncOutbox.deleteMany();
    await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false, appliedHubSeq: 0 } });
    const local = filled('task', { title: '开始对齐时的标题' });
    await replica.$transaction(tx => writeLive(tx, 'task', ids.shared, local));
    const concurrent: ReplicaTransport = { ...transport,
      pull: async () => ({ tip: 0, schemaVersion: localSchemaVersion(), ops: [] }),
      rows: async () => ({ rows: [] }),
      offer: async (entity, rows) => {
        if (entity === 'task') await replica.$transaction(tx => writeLive(tx, 'task', ids.shared, { ...local, title: '对齐期间新写的标题' }));
        return { tip: 0, results: rows.map(item => ({ id: item.id, status: 'conflict', row: entity === 'task' ? { ...item.row, title: '云端标题' } : item.row })) };
      },
    };
    await alignReplica(replica, concurrent);
    expect((await canonical(replica, 'task', ids.shared))?.title).toBe('对齐期间新写的标题');
  });

  it('rejects malformed baseline pages without marking the baseline ready', async () => {
    await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false } });
    const invalid: ReplicaTransport = { ...transport,
      pull: async () => ({ tip: 0, schemaVersion: localSchemaVersion(), ops: [] }),
      rows: async () => ({ rows: [{ id: 'z', row: filled('topic', {}) }, { id: 'a', row: filled('topic', {}) }] }),
    };
    await expect(alignReplica(replica, invalid)).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_ERROR' });
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).baselineReady).toBe(false);
  });

  it('rejects a snapshot with an invalid row before copying any entity', async () => {
    await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false } });
    const invalid: ReplicaTransport = { ...transport, snapshot: async () => ({ tip: 0, schemaVersion: localSchemaVersion(), entities: { topic: [{ id: 'must-not-copy-topic', row: filled('topic', { name: '不能先落库' }) }], tag: [], task: [{ id: 'bad-task', row: filled('task', { status: 'unsupported' }) }] } }) };
    await expect(alignReplica(replica, invalid)).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_ERROR' });
    expect(await replica.topic.findUnique({ where: { id: 'must-not-copy-topic' } })).toBe(null);
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).baselineReady).toBe(false);
  });

  it('offers parent tasks before children even when their IDs sort after children', async () => {
    await replica.syncState.update({ where: { id: 'local' }, data: { baselineReady: false } });
    await replica.$transaction(async tx => {
      await writeLive(tx, 'task', 'z-parent-sync-test', filled('task', { title: '后建的父任务' }));
      await writeLive(tx, 'task', 'a-child-sync-test', filled('task', { title: '先建的子任务', parentId: 'z-parent-sync-test' }));
    });
    await alignReplica(replica, { ...transport, snapshot: readSyncSnapshot });
    expect((await canonical(prisma, 'task', 'a-child-sync-test'))?.parentId).toBe('z-parent-sync-test');
    expect((await canonical(prisma, 'task', 'z-parent-sync-test'))?.title).toBe('后建的父任务');
  });

  it('recovers an expired log atomically while retaining edits made during snapshot download', async () => {
    await pendingFixture(); await replica.syncOutbox.deleteMany();
    const base = (await canonical(replica, 'task', ids.hubOnly))!;
    await replica.$transaction(tx => writeLive(tx, 'task', 'private-obsolete-cache', filled('task', { title: '已从服务器移除的旧缓存' })));
    const snapshot = await readSyncSnapshot(); snapshot.tip = 1000;
    const item = snapshot.entities.task.find(item => item.id === ids.hubOnly)!;
    item.row = { ...base, title: '云端的最新标题' };
    const transportWithGap: ReplicaTransport = {
      ...transport,
      pull: async after => ({ tip: 1000, schemaVersion: localSchemaVersion(), ops: after === 1000 ? [] : [{ seq: 1000, opId: 'retained-log-op', entityType: 'task', entityId: ids.hubOnly, before: base, after: item.row }] }),
      snapshot: async () => {
        const after = { ...base, description: '重新下载时继续写下的正文' };
        await replica.$transaction(async tx => {
          await writeLive(tx, 'task', ids.hubOnly, after);
          await tx.syncOutbox.create({ data: { opId: 'rebase-concurrent', entityType: 'task', entityId: ids.hubOnly, beforeJson: JSON.stringify(base), afterJson: JSON.stringify(after), state: 'pending', createdAt: new Date().toISOString() } });
        });
        return snapshot;
      },
    };
    await runReplicaCycle(replica, transportWithGap);
    expect(await canonical(replica, 'task', ids.hubOnly)).toMatchObject({ title: '云端的最新标题', description: '重新下载时继续写下的正文' });
    expect((await replica.syncOutbox.findUniqueOrThrow({ where: { opId: 'rebase-concurrent' } })).state).toBe('pending');
    expect((await replica.syncState.findUniqueOrThrow({ where: { id: 'local' } })).appliedHubSeq).toBe(1000);
    expect((await replica.task.findUniqueOrThrow({ where: { id: 'private-obsolete-cache' } })).deleteBatchId).toBe('sync-retired-cache');
    expect(await replica.syncOutbox.count({ where: { entityId: 'private-obsolete-cache' } })).toBe(0);
  });

});
