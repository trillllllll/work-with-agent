import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { prisma } from '../infrastructure/prisma.js';
import { workspaceQueryRouter } from './workspace-api.js';
import { ownerActor, type Actor } from './security.js';

const scope: Actor = { id: 'query-reader', kind: 'connection', topicIds: ['visible'], includeInbox: false, autoActions: [], revision: 1 };
function api(actor: Actor = scope) {
  const app = express();
  app.use((req, _res, next) => { (req as express.Request & { actor: Actor }).actor = actor; next(); });
  app.use('/api/v1', workspaceQueryRouter);
  app.use((error: { status?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message, code: error.code }); });
  return app;
}
async function clean() {
  await prisma.changeRecord.deleteMany(); await prisma.taskTopicAssignment.deleteMany(); await prisma.taskTag.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } }); await prisma.task.deleteMany(); await prisma.tag.deleteMany(); await prisma.topic.deleteMany();
}
async function fixtures() {
  await prisma.topic.createMany({ data: [{ id: 'visible', name: '授权清单' }, { id: 'hidden', name: '保密清单' }] });
  await prisma.task.createMany({ data: [{ id: 'active', title: '可见', topicId: 'visible' }, { id: 'trashed-a', title: '已删除 A', topicId: 'visible', deletedAt: '2026-01-03' }, { id: 'trashed-b', title: '已删除 B', topicId: 'visible', deletedAt: '2026-01-02' }, { id: 'hidden-task', title: '保密任务', topicId: 'hidden', deletedAt: '2026-01-04' }, { id: 'inbox', title: '收集箱任务', deletedAt: '2026-01-01' }] });
}

describe('scoped workspace discovery and audit queries', () => {
  beforeEach(async () => { await clean(); await fixtures(); });
  afterAll(clean);

  it('only exposes tags attached to authorized tasks and binds cursors to the query', async () => {
    await prisma.tag.createMany({ data: [{ id: 'tag-a', name: 'A' }, { id: 'tag-b', name: 'B' }, { id: 'secret-tag', name: '保密标签' }, { id: 'unused', name: '闲置' }] });
    await prisma.taskTag.createMany({ data: [{ taskId: 'active', tagId: 'tag-a' }, { taskId: 'trashed-a', tagId: 'tag-b' }, { taskId: 'hidden-task', tagId: 'secret-tag' }] });
    const first = await request(api()).get('/api/v1/tags?limit=1');
    expect(first.body.data).toMatchObject({ items: [{ id: 'tag-a' }], hasMore: true });
    const second = await request(api()).get('/api/v1/tags').query({ limit: 1, cursor: first.body.data.nextCursor });
    expect(second.body.data).toMatchObject({ items: [{ id: 'tag-b' }], hasMore: false, nextCursor: null });
    expect((await request(api(ownerActor)).get('/api/v1/tags')).body.data.items).toHaveLength(4);
    expect((await request(api()).get('/api/v1/trash/tasks').query({ cursor: first.body.data.nextCursor })).body.code).toBe('INVALID_CURSOR');
    expect((await request(api({ ...scope, revision: 2 })).get('/api/v1/tags').query({ cursor: first.body.data.nextCursor })).body.code).toBe('INVALID_CURSOR');
  });

  it('paginates only authorized deleted tasks and respects inbox grants', async () => {
    const first = await request(api()).get('/api/v1/trash/tasks?limit=1');
    expect(first.body.data).toMatchObject({ items: [{ id: 'trashed-a', allowedTransitions: [] }], hasMore: true });
    const second = await request(api()).get('/api/v1/trash/tasks').query({ cursor: first.body.data.nextCursor, limit: 1 });
    expect(second.body.data).toMatchObject({ items: [{ id: 'trashed-b' }], hasMore: false });
    expect((await request(api()).get('/api/v1/trash/tasks?topicId=hidden')).status).toBe(403);
    expect((await request(api()).get('/api/v1/trash/tasks?inbox=true')).status).toBe(403);
    expect((await request(api({ ...scope, topicIds: [], includeInbox: true })).get('/api/v1/trash/tasks')).body.data.items.map((row: { id: string }) => row.id)).toEqual(['inbox']);
  });

  it('redacts historical outside-scope IDs, names, reasons and conversation references', async () => {
    await prisma.taskTopicAssignment.create({ data: { id: 'move-history', taskId: 'active', fromTopicId: 'hidden', toTopicId: 'visible', reason: '从保密清单 hidden 移出', source: 'user', conversationId: 'private-chat', approvalId: 'private-approval', changedAt: '2026-01-03' } });
    const visible = await request(api()).get('/api/v1/tasks/active/history');
    expect(visible.body.data).toMatchObject({ items: [{ fromTopicId: null, fromTopic: null, fromRedacted: true, toTopicId: 'visible', toRedacted: false }], hasMore: false });
    const body = JSON.stringify(visible.body);
    for (const secret of ['hidden', '保密清单', 'private-chat', 'private-approval']) expect(body).not.toContain(secret);
    expect((await request(api(ownerActor)).get('/api/v1/tasks/active/history')).body.data.items[0].fromTopicId).toBe('hidden');
    expect((await request(api()).get('/api/v1/tasks/hidden-task/history')).status).toBe(403);
    await prisma.task.update({ where: { id: 'active' }, data: { topicId: 'hidden' } });
    expect((await request(api()).get('/api/v1/tasks/active/history')).status).toBe(403);
  });

  it('hides mixed/outside-scope audits and exposes safe metadata without snapshots', async () => {
    const group = (tasks: Record<string, unknown>) => ({ version: 2, entities: { tasks, topics: {}, tags: {} }, scopes: [] });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: 'active' } });
    const hidden = await prisma.task.findUniqueOrThrow({ where: { id: 'hidden-task' } });
    const data = [
      { id: 'safe', entityType: 'task', entityId: task.id, afterSnapshot: JSON.stringify(group({ [task.id]: task })), createdAt: '2026-01-05' },
      { id: 'safe-other', entityType: 'material', entityId: 'historical-material', afterSnapshot: JSON.stringify({ id: 'historical-material', topicId: 'visible', title: '仅owner可见的快照' }), createdAt: '2026-01-04' },
      { id: 'mixed', entityType: 'workspace', entityId: 'mixed-id', afterSnapshot: JSON.stringify(group({ [task.id]: task, [hidden.id]: hidden })), createdAt: '2026-01-03' },
      { id: 'compound', entityType: 'proposal', entityId: 'compound-id', afterSnapshot: JSON.stringify({ version: 3, changes: [{ entityType: 'task', entityId: task.id, snapshot: JSON.stringify(group({ [task.id]: task })) }, { entityType: 'memory', entityId: 'secret-memory', snapshot: JSON.stringify({ topicId: 'hidden' }) }] }), createdAt: '2026-01-02' },
      { id: 'unknown', entityType: 'execution', entityId: 'secret-command', afterSnapshot: '{}', createdAt: '2026-01-01' },
    ];
    await prisma.changeRecord.createMany({ data: data.map((row) => ({ ...row, source: 'user', operation: 'update', conversationId: 'private-chat', requestId: 'private-request' })) });
    const first = await request(api()).get('/api/v1/changes?limit=1');
    expect(first.body.data).toMatchObject({ items: [{ id: 'safe' }], hasMore: true });
    expect(first.body.data.items[0]).not.toHaveProperty('afterSnapshot');
    expect(first.body.data.items[0]).not.toHaveProperty('conversationId');
    const second = await request(api()).get('/api/v1/changes').query({ limit: 1, cursor: first.body.data.nextCursor });
    expect(second.body.data).toMatchObject({ items: [{ id: 'safe-other' }], hasMore: false });
    expect((await request(api()).get('/api/v1/changes?entityId=mixed-id')).body.data.items).toEqual([]);
    expect((await request(api(ownerActor)).get('/api/v1/changes')).body.data.items).toHaveLength(5);
    await prisma.task.update({ where: { id: 'active' }, data: { topicId: 'hidden' } });
    expect((await request(api()).get('/api/v1/changes')).body.data.items.map((row: { id: string }) => row.id)).toEqual(['safe-other']);
  });
});
