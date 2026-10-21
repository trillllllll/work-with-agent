import supertest from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { connectionTokenActive } from './security.js';

describe('connection lastUsedAt', () => {
  const ids: string[] = [];
  const topicIds: string[] = [];

  afterAll(async () => {
    if (ids.length) await prisma.connection.deleteMany({ where: { id: { in: ids } } });
    if (topicIds.length) await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  });

  it('stamps Bearer and MCP use, keeps the value for five minutes, and skips the owner cookie', async () => {
    const session = await ownerSession(app);
    const topic = await prisma.topic.create({ data: { name: 'last-used 清单', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    topicIds.push(topic.id);
    const created = await supertest(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: '用量', host: 'codex', topicIds: [topic.id] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.data.id as string;
    const token = created.body.data.token as string;
    ids.push(id);
    const before = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(before.lastUsedAt).toBeNull();

    const authed = await supertest(app).get('/api/v1/tasks').set('Authorization', `Bearer ${token}`);
    expect(authed.status, JSON.stringify(authed.body)).toBe(200);
    const stamped = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(stamped.lastUsedAt).toEqual(expect.any(String));
    expect(Date.parse(stamped.lastUsedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(stamped.revision).toBe(before.revision);
    expect(stamped.updatedAt).toBe(before.updatedAt);

    const recent = new Date(Date.now() - 60_000).toISOString();
    await prisma.connection.update({ where: { id }, data: { lastUsedAt: recent } });
    const again = await supertest(app).get('/api/v1/tasks').set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(200);
    const held = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(held.lastUsedAt).toBe(recent);
    expect(held.revision).toBe(before.revision);
    expect(held.updatedAt).toBe(before.updatedAt);

    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    await prisma.connection.update({ where: { id }, data: { lastUsedAt: stale } });
    expect(await connectionTokenActive(token)).toBe(true);
    const touched = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(Date.parse(touched.lastUsedAt!)).toBeGreaterThan(Date.parse(stale));
    expect(touched.revision).toBe(before.revision);
    expect(touched.updatedAt).toBe(before.updatedAt);
    expect(await connectionTokenActive('not-a-real-token')).toBe(false);

    const frozen = touched.lastUsedAt;
    const owner = await supertest(app).get('/api/topics').set('Cookie', session.cookie);
    expect(owner.status).toBe(200);
    const afterOwner = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(afterOwner.lastUsedAt).toBe(frozen);
    expect(afterOwner.revision).toBe(before.revision);
    expect(afterOwner.updatedAt).toBe(before.updatedAt);
  });
});
