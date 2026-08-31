import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { db } from './services.js';

describe('Agent tool gate', () => {
  let topicId = '';
  let taskId = '';

  it('requires approval before creating a task', async () => {
    const topic = await request(app).post('/api/topics').send({ name: `Agent 测试-${Date.now()}`, isExploration: true });
    topicId = topic.body.data.id;
    const response = await request(app).post('/api/chat').send({ message: '创建任务：通过审核后创建', pageContext: { topicId, page: 'board' } });
    expect(response.status).toBe(200);
    expect(response.body.data.events.some((event: any) => event.type === 'approval_required')).toBe(true);
    const approval = response.body.data.events.find((event: any) => event.type === 'approval_required');
    const before = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(before.body.data).toHaveLength(0);
    const approved = await request(app).post(`/api/agent/approvals/${approval.approvalId}/approve`);
    expect(approved.status).toBe(200);
    const after = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(after.body.data).toHaveLength(1);
    taskId = after.body.data[0].id;
  });

  afterAll(() => {
    if (taskId) db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
    if (topicId) db.prepare('DELETE FROM topics WHERE id=?').run(topicId);
  });
});
