import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { TaskService } from './workspace.js';
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
});
