import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { TopicService } from './workspace.js';

const topicIds: string[] = [];
const connectionIds: string[] = [];

async function owner(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) {
  const session = await ownerSession(app);
  const query = request(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return body === undefined ? query : query.send(body);
}

async function createTopic(name: string) {
  const row = await new TopicService().create({ name });
  topicIds.push(row.id);
  return row;
}

async function createConnection(topicIdsForConnection: string[], name = '列表测试连接') {
  const response = await owner('post', '/api/v1/connections', { name, host: 'codex', topicIds: topicIdsForConnection, autoActions: [], includeInbox: false });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  connectionIds.push(response.body.data.id);
  return response;
}

async function listConnections() {
  const response = await owner('get', '/api/v1/connections');
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Array<Record<string, unknown>>;
}

function rowById(rows: Array<Record<string, unknown>>, id: string) {
  const row = rows.find((item) => item.id === id);
  expect(row, id).toBeTruthy();
  return row!;
}

describe('connection list health', () => {
  afterAll(async () => {
    await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
    if (topicIds.length) await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  });

  it('marks a new connection healthy, keeps activity keys, and does not add those fields to POST', async () => {
    const topic = await createTopic('健康清单');
    const created = await createConnection([topic.id]);
    expect(created.body.data).not.toHaveProperty('healthy');
    expect(created.body.data).not.toHaveProperty('missingTopicIds');
    const row = rowById(await listConnections(), created.body.data.id);
    expect(row).toMatchObject({
      name: '列表测试连接',
      host: 'codex',
      status: 'active',
      topicIds: [topic.id],
      includeInbox: false,
      autoActions: [],
      healthy: true,
      missingTopicIds: [],
    });
    expect(row).toHaveProperty('lastCommandAt', null);
    expect(row).toHaveProperty('lastWriteAt', null);
    expect(row).toHaveProperty('lastWriteOperation', null);
  });

  it('puts a deleted topic in missingTopicIds and marks the connection unhealthy', async () => {
    const kept = await createTopic('留下的清单');
    const gone = await createTopic('删除的清单');
    const created = await createConnection([kept.id, gone.id]);
    await prisma.topic.delete({ where: { id: gone.id } });
    const row = rowById(await listConnections(), created.body.data.id);
    expect(row.topicIds).toEqual([kept.id, gone.id]);
    expect(row.missingTopicIds).toEqual([gone.id]);
    expect(row.healthy).toBe(false);
  });

  it('does not treat an archived topic as missing', async () => {
    const live = await createTopic('仍在使用');
    const archived = await createTopic('已经归档');
    const created = await createConnection([live.id, archived.id]);
    await prisma.topic.update({ where: { id: archived.id }, data: { archivedAt: '2026-10-20T00:00:00.000Z' } });
    const row = rowById(await listConnections(), created.body.data.id);
    expect(row.missingTopicIds).toEqual([]);
    expect(row.missingTopicIds).not.toContain(archived.id);
    expect(row.healthy).toBe(true);
  });

  it('marks a revoked connection unhealthy even when every topic still exists', async () => {
    const topic = await createTopic('撤销后仍在');
    const created = await createConnection([topic.id]);
    const removed = await owner('delete', `/api/v1/connections/${created.body.data.id}`, { expectedRevision: created.body.data.revision });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const row = rowById(await listConnections(), created.body.data.id);
    expect(row.status).toBe('revoked');
    expect(row.missingTopicIds).toEqual([]);
    expect(row.healthy).toBe(false);
  });

  it('orders connections by createdAt descending', async () => {
    const topic = await createTopic('排序清单');
    const older = await createConnection([topic.id], '较旧连接');
    const newer = await createConnection([topic.id], '较新连接');
    await prisma.connection.update({ where: { id: older.body.data.id }, data: { createdAt: '2020-01-01T00:00:00.000Z' } });
    await prisma.connection.update({ where: { id: newer.body.data.id }, data: { createdAt: '2026-10-20T00:00:00.000Z' } });
    const rows = await listConnections();
    const times = rows.map((row) => String(row.createdAt));
    expect(times).toEqual([...times].sort((left, right) => right.localeCompare(left)));
    const olderIndex = rows.findIndex((row) => row.id === older.body.data.id);
    const newerIndex = rows.findIndex((row) => row.id === newer.body.data.id);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThan(newerIndex);
  });
});
