import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { db } from './services.js';

describe('REST task workflow', () => {
  let topicId = '';
  let taskId = '';

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

  afterAll(() => {
    if (taskId) db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
    if (topicId) db.prepare('DELETE FROM topics WHERE id=?').run(topicId);
  });
});
