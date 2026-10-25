import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { TaskService } from './workspace.js';
import { pairSyncDevice, pushSyncOps, readSyncSnapshot, readLive } from './sync-log.js';
import { localSchemaVersion } from './snapshots.js';

const secret = 'sync-secret-should-not-leak';
const taskIds: string[] = [];
const deviceIds: string[] = [];

async function owner(method: 'get' | 'post', path: string, body?: object) {
  const session = await ownerSession(app);
  const query = request(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return body === undefined ? query : query.send(body);
}

describe('hub sync for tasks', () => {
  afterAll(async () => {
    await prisma.syncConflict.deleteMany({ where: { entityId: { in: taskIds } } });
    await prisma.syncOp.deleteMany({ where: { entityId: { in: taskIds } } });
    await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.syncReceipt.deleteMany();
    await prisma.syncDevice.deleteMany({ where: { id: { in: deviceIds } } });
    const setting = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    if (setting?.openaiApiKey === secret) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiApiKey: '' } });
  });

  it('records a task write, merges different fields, and keeps a same-field conflict', async () => {
    expect((await request(app).get('/api/v1/sync/pull')).status).toBe(401);
    await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiApiKey: secret, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, update: { openaiApiKey: secret } });
    const created = await new TaskService().create({ title: '对齐任务' }, { source: 'user' });
    taskIds.push(created.id);
    const stored = await prisma.syncOp.findFirstOrThrow({ where: { entityId: created.id, entityType: 'task' }, orderBy: { seq: 'desc' } });
    const listed = await owner('get', `/api/v1/sync/pull?after=${stored.seq - 1}&limit=20`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const logged = listed.body.data.ops.find((op: { entityId: string; entityType: string }) => op.entityId === created.id && op.entityType === 'task');
    expect(logged.after.title).toBe('对齐任务');
    const base = logged.after;
    const pair = async (name: string) => {
      const response = await owner('post', '/api/v1/sync/devices', { name });
      expect(response.status).toBe(200);
      deviceIds.push(response.body.data.deviceId);
      return response.body.data.token as string;
    };
    const push = (token: string, opId: string, after: Record<string, unknown>) => request(app).post('/api/v1/sync/push').set('Authorization', `Bearer ${token}`).send({ schemaVersion: localSchemaVersion(), ops: [{ opId, entityType: 'task', entityId: created.id, before: base, after }] });
    const title = await push(await pair('甲'), 'op-title-change-0001', { ...base, title: '甲' });
    const status = await push(await pair('乙'), 'op-status-change-0001', { ...base, status: 'doing' });
    expect(title.body.data.results[0].status).toBe('applied');
    expect(status.body.data.results[0].status).toBe('applied');
    const again = await push(await pair('甲重复'), 'op-title-change-0001', { ...base, title: '甲' });
    expect(again.body.data.results[0].status).toBe('duplicate');
    expect(await prisma.syncOp.count({ where: { opId: 'op-title-change-0001' } })).toBe(1);
    const conflict = await push(await pair('丙'), 'op-title-conflict-0001', { ...base, title: '丙' });
    expect(conflict.body.data.results[0].status).toBe('conflict');
    const saved = await prisma.task.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.title).toBe('甲');
    expect(saved.status).toBe('doing');
    const inbox = await owner('get', '/api/v1/sync/conflicts');
    const row = inbox.body.data.find((item: { entityId: string; field: string }) => item.entityId === created.id && item.field === 'title');
    expect(row.incoming).toBe('丙');
    const resolved = await owner('post', `/api/v1/sync/conflicts/${row.id}/resolve`, { choice: 'mine' });
    expect(resolved.status).toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: created.id } })).title).toBe('丙');
    expect((await owner('get', '/api/v1/sync/conflicts')).body.data.some((item: { id: string }) => item.id === row.id)).toBe(false);
  });
  it('durably acknowledges no-ops and conflicts and rejects opId reuse', async () => {
    const created = await new TaskService().create({ title: '回执重试' }, { source: 'user' });
    taskIds.push(created.id);
    const device = await pairSyncDevice('receipt-test'); deviceIds.push(device.deviceId);
    const base = (await prisma.$transaction(tx => readLive(tx, 'task', created.id))).row!;
    const noop = { opId: 'receipt-noop-0001', entityType: 'task', entityId: created.id, before: base, after: base };
    const push = (ops: typeof noop[]) => pushSyncOps(device.deviceId, { schemaVersion: localSchemaVersion(), ops });
    expect((await push([noop])).results[0].seq).toBe(null);
    await prisma.task.update({ where: { id: created.id }, data: { title: '确认丢失后的其他设备修改' } });
    expect((await push([noop])).results[0].status).toBe('duplicate');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: created.id } })).title).toBe('确认丢失后的其他设备修改');
    await expect(push([{ ...noop, after: { ...base, title: '同编号另一请求' } }])).rejects.toMatchObject({ code: 'SYNC_OP_REUSED' });
    const conflicting = { ...noop, opId: 'receipt-conflict-01', after: { ...base, title: '离线标题' } };
    expect((await push([conflicting])).results[0].status).toBe('conflict');
    const count = await prisma.syncConflict.count({ where: { opId: conflicting.opId } });
    expect((await push([conflicting])).results[0].status).toBe('duplicate');
    expect(await prisma.syncConflict.count({ where: { opId: conflicting.opId } })).toBe(count);
    await push([{ ...conflicting, opId: 'receipt-conflict-02', after: { ...base, title: '第三份离线标题' } }]);
    expect(await prisma.syncConflict.count({ where: { entityId: created.id, field: 'title' } })).toBe(count + 1);
  });

  it('returns one baseline with its log cursor and excludes settings and credentials', async () => {
    const snapshot = await readSyncSnapshot();
    expect(snapshot.schemaVersion).toBe(localSchemaVersion());
    expect(snapshot.entities.task.some(item => taskIds.includes(item.id))).toBe(true);
    expect(Object.keys(snapshot.entities).sort()).toEqual(['tag', 'task', 'topic']);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    const unauthorized = await request(app).get(`/api/v1/sync/baseline/snapshot?schemaVersion=${localSchemaVersion()}`);
    expect(unauthorized.status).toBe(401);
    const authorized = await owner('get', `/api/v1/sync/baseline/snapshot?schemaVersion=${localSchemaVersion()}`);
    expect(authorized.status).toBe(200);
    expect(authorized.headers['cache-control']).toBe('no-store');
    expect((await owner('get', '/api/v1/sync/baseline/snapshot?schemaVersion=old')).status).toBe(409);
  });

  it('preserves historical creation and completion times instead of stamping the download date', async () => {
    const created = await new TaskService().create({ title: '历史完成日期' }, { source: 'user' }); taskIds.push(created.id);
    const device = await pairSyncDevice('history-time'); deviceIds.push(device.deviceId);
    const base = (await prisma.$transaction(tx => readLive(tx, 'task', created.id))).row!;
    const after = { ...base, status: 'done', createdAt: '2020-01-02T03:04:05.000Z', completedAt: '2020-02-03T04:05:06.000Z', completedAtEstimated: false };
    await pushSyncOps(device.deviceId, { schemaVersion: localSchemaVersion(), ops: [{ opId: 'history-time-operation', entityType: 'task', entityId: created.id, before: base, after }] });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ createdAt: after.createdAt, completedAt: after.completedAt, completedAtEstimated: false });
  });
  it('retains missing-reference conflicts without blocking unrelated edits', async () => {
    const one = await new TaskService().create({ title: '引用已被另一端删除' }, { source: 'user' });
    const two = await new TaskService().create({ title: '无关任务' }, { source: 'user' }); taskIds.push(one.id, two.id);
    const device = await pairSyncDevice('reference-conflict'); deviceIds.push(device.deviceId);
    const base = (await prisma.$transaction(tx => readLive(tx, 'task', one.id))).row!;
    const other = (await prisma.$transaction(tx => readLive(tx, 'task', two.id))).row!;
    await pushSyncOps(device.deviceId, { schemaVersion: localSchemaVersion(), ops: [
      { opId: 'reference-conflict-01', entityType: 'task', entityId: one.id, before: base, after: { ...base, title: '正文仍能保存', topicId: 'gone-topic', parentId: 'gone-parent', tagIds: ['gone-tag'] } },
      { opId: 'reference-conflict-02', entityType: 'task', entityId: two.id, before: other, after: { ...other, description: '不受影响' } },
    ] });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: one.id } })).toMatchObject({ title: '正文仍能保存', topicId: null, parentId: null });
    expect(await prisma.syncConflict.count({ where: { entityId: one.id } })).toBe(3);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: two.id } })).description).toBe('不受影响');
  });

});
