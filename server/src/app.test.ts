import request from './test-auth.js';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './services.js';

describe('REST task workflow', () => {
  let topicId = '';
  let taskId = '';
  let inboxTaskId = '';

  it('creates a topic and a task', async () => {
    const topic = await request(app).post('/api/topics').send({ name: `测试主题-${Date.now()}`, isExploration: true });
    expect(topic.status).toBe(200);
    topicId = topic.body.data.id;
    const task = await request(app).post('/api/tasks').send({ topicId, title: '测试任务' });
    expect(task.status).toBe(200);
    expect(task.body.data.status).toBe('todo');
    expect(task.body.data.priority).toBe('none');
    expect(task.body.data.dueDate).toBeNull();
    taskId = task.body.data.id;
  });

  it('updates task status', async () => {
    const updated = await request(app).patch(`/api/tasks/${taskId}`).send({ status: 'doing', priority: 'high', dueDate: '2026-09-30' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('doing');
    expect(updated.body.data.priority).toBe('high');
    expect(updated.body.data.dueDate).toBe('2026-09-30');
    const cleared = await request(app).patch(`/api/tasks/${taskId}`).send({ priority: 'none', dueDate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.priority).toBe('none');
    expect(cleared.body.data.dueDate).toBeNull();
  });

  it('creates inbox tasks and moves them into an existing topic', async () => {
    const invalid = await request(app).post('/api/tasks').send({ title: '非法初始状态', status: 'doing' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_INITIAL_TASK_STATUS');
    const created = await request(app).post('/api/tasks').send({ title: '待整理任务', description: '先记录背景', resultSummary: '保留结果' });
    expect(created.status).toBe(200);
    expect(created.body.data.topicId).toBeNull();
    expect(created.body.data.status).toBe('todo');
    expect(created.body.data.allowedTransitions).toEqual(['doing', 'done']);
    inboxTaskId = created.body.data.id;
    const inbox = await request(app).get('/api/tasks?inbox=true');
    expect(inbox.body.data.some((task: any) => task.id === inboxTaskId)).toBe(true);
    const moved = await request(app).patch(`/api/tasks/${inboxTaskId}`).send({ topicId });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ topicId, title: '待整理任务', description: '先记录背景', resultSummary: '保留结果', status: 'todo' });
    expect((await request(app).get('/api/tasks?inbox=true')).body.data.some((task: any) => task.id === inboxTaskId)).toBe(false);
  });

  it('enforces task status transitions', async () => {
    const created = await request(app).post('/api/tasks').send({ topicId, title: '状态机任务' });
    const stateTaskId = created.body.data.id;
    const completed = await request(app).patch(`/api/tasks/${stateTaskId}`).send({ status: 'done' });
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('done');
    expect((await request(app).patch(`/api/tasks/${stateTaskId}`).send({ status: 'todo' })).body.data.status).toBe('todo');
    expect((await request(app).patch(`/api/tasks/${stateTaskId}`).send({ status: 'doing' })).body.data.allowedTransitions).toEqual(['todo', 'blocked', 'done']);
    await request(app).delete(`/api/tasks/${stateTaskId}`);
    await request(app).delete(`/api/trash/tasks/${stateTaskId}/permanent`);
  });

  it('returns stable boolean fields and 404s for missing resources', async () => {
    const topics = await request(app).get('/api/topics');
    expect(typeof topics.body.data[0].isExploration).toBe('boolean');
    expect((await request(app).get('/api/topics/missing-topic')).status).toBe(404);
    expect((await request(app).get('/api/tasks/missing-task')).status).toBe(404);
  });

  it('moves tasks to trash, restores them, and permanently deletes them', async () => {
    const created = await request(app).post('/api/tasks').send({ topicId, title: '回收站任务' });
    const trashTaskId = created.body.data.id;
    expect((await request(app).delete(`/api/tasks/${trashTaskId}`)).status).toBe(200);
    expect((await request(app).get(`/api/tasks/${trashTaskId}`)).status).toBe(404);
    const trash = await request(app).get('/api/trash/tasks');
    expect(trash.status).toBe(200);
    expect(trash.body.data.find((task: any) => task.id === trashTaskId)?.deletedAt).toBeTruthy();
    const restored = await request(app).post(`/api/trash/tasks/${trashTaskId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.deletedAt).toBeNull();
    expect((await request(app).get(`/api/tasks/${trashTaskId}`)).status).toBe(200);
    expect((await request(app).delete(`/api/tasks/${trashTaskId}`)).status).toBe(200);
    expect((await request(app).delete(`/api/trash/tasks/${trashTaskId}/permanent`)).status).toBe(200);
    expect((await request(app).delete(`/api/trash/tasks/${trashTaskId}/permanent`)).status).toBe(409);
  });

  it('archives topics, unassigns tasks, records history, and restores them through undo', async () => {
    const topic = (await request(app).post('/api/topics').send({ name: `归档主题-${Date.now()}` })).body.data;
    const active = (await request(app).post('/api/tasks').send({ topicId: topic.id, title: '归档活动任务' })).body.data;
    const trashed = (await request(app).post('/api/tasks').send({ topicId: topic.id, title: '归档回收任务' })).body.data;
    await request(app).delete(`/api/tasks/${trashed.id}`);

    expect((await request(app).delete(`/api/topics/${topic.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/topics/${topic.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/tasks/${active.id}`)).body.data.topicId).toBeNull();
    expect((await request(app).get('/api/trash/tasks')).body.data.find((item: any) => item.id === trashed.id).topicId).toBeNull();
    const history = (await request(app).get(`/api/tasks/${active.id}/topic-history`)).body.data;
    expect(history.map((item: any) => item.reason)).toEqual(['created', 'topic_archived']);
    expect(history[1].fromTopic.name).toBe(topic.name);

    const changes = (await request(app).get(`/api/changes?entityType=topic&entityId=${topic.id}`)).body.data;
    const archive = changes.find((item: any) => item.operation === 'archive');
    expect(archive.reversible).toBe(true);
    expect((await request(app).post(`/api/changes/${archive.id}/undo`)).status).toBe(200);
    expect((await request(app).get(`/api/topics/${topic.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/tasks/${active.id}`)).body.data.topicId).toBe(topic.id);

    await request(app).delete(`/api/tasks/${active.id}`);
    await request(app).delete(`/api/trash/tasks/${active.id}/permanent`);
    await request(app).delete(`/api/trash/tasks/${trashed.id}/permanent`);
    await prisma.topic.delete({ where: { id: topic.id } });
  });

  it('rejects archive undo after an affected task is reassigned', async () => {
    const source = (await request(app).post('/api/topics').send({ name: `冲突来源-${Date.now()}` })).body.data;
    const target = (await request(app).post('/api/topics').send({ name: `冲突目标-${Date.now()}` })).body.data;
    const task = (await request(app).post('/api/tasks').send({ topicId: source.id, title: '归属已变化' })).body.data;
    await request(app).delete(`/api/topics/${source.id}`);
    await request(app).patch(`/api/tasks/${task.id}`).send({ topicId: target.id });
    const changes = (await request(app).get(`/api/changes?entityType=topic&entityId=${source.id}`)).body.data;
    const response = await request(app).post(`/api/changes/${changes.find((item: any) => item.operation === 'archive').id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UNDO_CONFLICT');
    await request(app).delete(`/api/tasks/${task.id}`);
    await request(app).delete(`/api/trash/tasks/${task.id}/permanent`);
    await prisma.topic.deleteMany({ where: { id: { in: [source.id, target.id] } } });
  });

  it('records a reverse assignment when an assignment change is undone', async () => {
    const topic = (await request(app).post('/api/topics').send({ name: `撤销归属-${Date.now()}` })).body.data;
    const task = (await request(app).post('/api/tasks').send({ title: '撤销归属任务' })).body.data;
    await request(app).patch(`/api/tasks/${task.id}`).send({ topicId: topic.id });
    const changes = (await request(app).get(`/api/changes?entityType=task&entityId=${task.id}`)).body.data;
    await request(app).post(`/api/changes/${changes.find((item: any) => item.operation === 'update').id}/undo`);
    expect((await request(app).get(`/api/tasks/${task.id}`)).body.data.topicId).toBeNull();
    const history = (await request(app).get(`/api/tasks/${task.id}/topic-history`)).body.data;
    expect(history.map((item: any) => item.reason)).toEqual(['assigned', 'undo']);
    await request(app).delete(`/api/tasks/${task.id}`);
    await request(app).delete(`/api/trash/tasks/${task.id}/permanent`);
    await prisma.topic.delete({ where: { id: topic.id } });
  });

  afterAll(async () => {
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
    if (inboxTaskId) await prisma.task.delete({ where: { id: inboxTaskId } }).catch(() => undefined);
    if (topicId) await prisma.topic.delete({ where: { id: topicId } }).catch(() => undefined);
    await prisma.$disconnect();
  });
});
