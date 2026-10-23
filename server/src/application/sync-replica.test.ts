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
import { syncFields, type SyncRow } from './sync-merge.js';
import { listBaselineRows, offerBaselineRows, pairSyncDevice, pullSyncOps, pushSyncOps, readLive, writeLive } from './sync-log.js';
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
  for (const field of syncFields[entity]) row[field] = field === 'tagIds' ? [] : null;
  if (entity === 'task') Object.assign(row, { title: '', description: '', status: 'todo', priority: 'none', resultSummary: '', sortOrder: 0 });
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
    const taskIds = [ids.hubOnly, ids.replicaOnly, ids.shared];
    const topicIds = [ids.hubTopic, ids.replicaTopic];
    await prisma.syncConflict.deleteMany({ where: { entityId: { in: [...taskIds, ...topicIds] } } });
    await prisma.syncOp.deleteMany({ where: { entityId: { in: [...taskIds, ...topicIds] } } });
    await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
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
    const previous = process.env.WWA_DATA_DIR;
    const directory = mkdtempSync(join(tmpdir(), 'wwa-sync-bind-'));
    process.env.WWA_DATA_DIR = directory;
    try {
      writeSyncBinding({ url: 'https://wwa.example.com', token: 'a'.repeat(32) });
      expect(readSyncBinding()?.url).toBe('https://wwa.example.com');
      expect(statSync(join(directory, 'sync-device.json')).mode & 0o777).toBe(0o600);
      expect(readSyncBinding()?.token).toBe('a'.repeat(32));
    } finally {
      if (previous === undefined) delete process.env.WWA_DATA_DIR;
      else process.env.WWA_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aligns both sides, then merges fields and keeps a same-field conflict', async () => {
    expect((await request(app).get('/api/v1/sync/baseline/rows?entity=task')).status).toBe(401);
    const session = await ownerSession(app);
    const previousData = process.env.WWA_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'wwa-sync-status-'));
    process.env.WWA_DATA_DIR = dataDir;
    try {
      expect((await request(app).get('/api/v1/sync/status').set('Cookie', session.cookie)).body.data.bound).toBe(false);
    } finally {
      if (previousData === undefined) delete process.env.WWA_DATA_DIR;
      else process.env.WWA_DATA_DIR = previousData;
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

    const aligned = await alignReplica(replica, transport);
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
    const previousUrl = process.env.WWA_SYNC_URL;
    const previousToken = process.env.WWA_SYNC_TOKEN;
    process.env.WWA_SYNC_URL = 'https://wwa.example.com';
    process.env.WWA_SYNC_TOKEN = 'b'.repeat(32);
    try {
      await replica.$transaction(async (tx) => {
        await recordCommittedGroup(tx, 'change-enqueue-1', { entities: { tasks: { [ids.replicaOnly]: null }, topics: {}, tags: {} } }, { entities: { tasks: { [ids.replicaOnly]: await readLive(tx, 'task', ids.replicaOnly).then((item) => item.row) }, topics: {}, tags: {} } });
      });
    } finally {
      if (previousUrl === undefined) delete process.env.WWA_SYNC_URL;
      else process.env.WWA_SYNC_URL = previousUrl;
      if (previousToken === undefined) delete process.env.WWA_SYNC_TOKEN;
      else process.env.WWA_SYNC_TOKEN = previousToken;
    }
    expect(await replica.syncOutbox.count({ where: { opId: { startsWith: 'change-enqueue-1:' } } })).toBe(1);
  }, 30_000);
});
