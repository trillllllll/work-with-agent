import request from 'supertest';
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
    taskId = task.body.data.id;
  });

  it('updates task status and protects non-empty topic deletion', async () => {
    const updated = await request(app).patch(`/api/tasks/${taskId}`).send({ status: 'doing' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('doing');
    const deleted = await request(app).delete(`/api/topics/${topicId}`);
    expect(deleted.status).toBe(409);
  });

  it('creates inbox tasks and moves them into an existing topic', async () => {
    const created = await request(app).post('/api/tasks').send({ title: '待整理任务', description: '先记录背景', resultSummary: '保留结果', status: 'doing' });
    expect(created.status).toBe(200);
    expect(created.body.data.topicId).toBeNull();
    expect(created.body.data.status).toBe('doing');
    inboxTaskId = created.body.data.id;
    const inbox = await request(app).get('/api/tasks?inbox=true');
    expect(inbox.body.data.some((task: any) => task.id === inboxTaskId)).toBe(true);
    const moved = await request(app).patch(`/api/tasks/${inboxTaskId}`).send({ topicId });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ topicId, title: '待整理任务', description: '先记录背景', resultSummary: '保留结果', status: 'doing' });
    expect((await request(app).get('/api/tasks?inbox=true')).body.data.some((task: any) => task.id === inboxTaskId)).toBe(false);
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

  afterAll(async () => {
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
    if (inboxTaskId) await prisma.task.delete({ where: { id: inboxTaskId } }).catch(() => undefined);
    if (topicId) await prisma.topic.delete({ where: { id: topicId } }).catch(() => undefined);
    await prisma.$disconnect();
  });
});
