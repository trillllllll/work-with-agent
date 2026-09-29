import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import ownerRequest from '../test-auth.js';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { workspaceQueryRouter } from './workspace-api.js';
import { taskActivity } from './task-activity.js';
import { ownerActor, type Actor } from './security.js';

const api = ownerRequest(app);

async function clean() {
  await prisma.changeRecord.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.connection.deleteMany();
}
async function topic(name: string) {
  const response = await api.post('/api/topics').send({ name });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; name: string };
}
async function task(input: Record<string, unknown> = {}) {
  const response = await api.post('/api/tasks').send({ title: '任务', ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number };
}
async function patch(id: string, input: Record<string, unknown>) {
  const response = await api.patch(`/api/tasks/${id}`).send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}
async function activity(id: string) {
  const response = await api.get(`/api/tasks/${id}/activity`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Array<{ id: string; action: string; actor: { name: string }; changes: Array<Record<string, any>> }>;
}

describe('task activity', () => {
  beforeEach(clean);
  afterAll(clean);

  it('records created text, completion, flag, date, tags and list moves, including the previous description', async () => {
    const list = await topic('工作');
    const label = (await api.post('/api/tags').send({ name: '标签甲' })).body.data;
    const item = await task();
    await patch(item.id, { title: '新标题', description: '第一版说明' });
    await patch(item.id, { description: '第二版说明，需要完整保留' });
    await patch(item.id, { priority: 'high', dueDate: '2026-10-02' });
    await patch(item.id, { tagIds: [label.id] });
    await patch(item.id, { topicId: list.id });
    await patch(item.id, { status: 'done' });

    const events = await activity(item.id);
    expect(events.at(-1)).toMatchObject({ action: 'create', actor: { name: '你' }, changes: [] });
    const description = events.find((event) => event.changes.some((change) => change.field === 'description' && change.after === '第二版说明，需要完整保留'));
    expect(description?.changes).toContainEqual({ field: 'description', before: '第一版说明', after: '第二版说明，需要完整保留' });
    expect(events.some((event) => event.changes.some((change) => change.field === 'title' && change.before === '任务' && change.after === '新标题'))).toBe(true);
    expect(events.some((event) => event.changes.some((change) => change.field === 'priority' && change.before === 'none' && change.after === 'high'))).toBe(true);
    expect(events.some((event) => event.changes.some((change) => change.field === 'dueDate' && change.before === null && change.after === '2026-10-02'))).toBe(true);
    expect(events.some((event) => event.changes.some((change) => change.field === 'tagIds' && change.before.length === 0 && change.after[0] === '标签甲'))).toBe(true);
    expect(events.some((event) => event.changes.some((change) => change.field === 'topicId' && change.before.name === '收集箱' && change.after.name === '工作'))).toBe(true);
    expect(events.some((event) => event.changes.some((change) => change.field === 'status' && change.before === 'todo' && change.after === 'done'))).toBe(true);
    expect(events.every((event) => event.changes.every((change) => change.field !== 'sortOrder'))).toBe(true);
  });

  it('omits a reorder that only changes sort position', async () => {
    const list = await topic('排序');
    const first = await task({ topicId: list.id, title: '先做' });
    const second = await task({ topicId: list.id, title: '后做' });
    const before = await activity(first.id);
    const response = await api.post('/api/tasks/reorder').send({ topicId: list.id, parentId: null, orderedTaskIds: [second.id, first.id] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await activity(first.id)).toEqual(before);
  });

  it('shows a child status change on the child when the parent completion writes it', async () => {
    const list = await topic('父子');
    const parent = await task({ topicId: list.id, title: '父任务' });
    const child = await task({ topicId: list.id, parentId: parent.id, title: '子任务' });
    await patch(parent.id, { status: 'done', completeChildren: true });
    const events = await activity(child.id);
    expect(events.some((event) => event.changes.some((change) => change.field === 'status' && change.before === 'todo' && change.after === 'done'))).toBe(true);
  });

  it('hides a task outside the connection and redacts list names the connection cannot read', async () => {
    const visible = await topic('授权清单');
    const hidden = await topic('保密清单');
    const item = await task({ topicId: visible.id, title: '可见任务' });
    await patch(item.id, { topicId: hidden.id });
    await patch(item.id, { topicId: visible.id });
    const actor: Actor = { id: 'activity-reader', kind: 'connection', connectionId: 'activity-reader', topicIds: [visible.id], includeInbox: false, autoActions: [], revision: 1 };
    await expect(taskActivity(actor, item.id)).resolves.toEqual(expect.any(Array));
    const events = await taskActivity(actor, item.id);
    const body = JSON.stringify(events);
    expect(body).not.toContain(hidden.id);
    expect(body).not.toContain('保密清单');
    expect(body).toContain('范围外清单');
    const secret = await task({ topicId: hidden.id, title: '看不见' });
    await expect(taskActivity(actor, secret.id)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    const v1 = express();
    v1.use((req, _res, next) => { (req as express.Request & { actor: Actor }).actor = actor; next(); });
    v1.use('/api/v1', workspaceQueryRouter);
    v1.use((error: { status?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, code: error.code });
    });
    expect((await request(v1).get(`/api/v1/tasks/${secret.id}/activity`)).status).toBe(403);
    const visibleResponse = await request(v1).get(`/api/v1/tasks/${item.id}/activity`);
    expect(visibleResponse.status).toBe(200);
    expect(JSON.stringify(visibleResponse.body)).not.toContain(hidden.id);
    expect((await taskActivity(ownerActor, item.id)).some((event) => JSON.stringify(event).includes('保密清单'))).toBe(true);
  });
});
