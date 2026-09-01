import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './services.js';

describe('Agent tool gate', () => {
  let topicId = '';
  let taskId = '';

  it('requires approval before creating a task', async () => {
    const topic = await request(app).post('/api/topics').send({ name: `Agent 测试-${Date.now()}`, isExploration: true });
    topicId = topic.body.data.id;
    const response = await request(app).post('/api/chat').send({ message: '创建任务：通过审核后创建', pageContext: { topicId, page: 'board' } });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = response.text.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      return { event, ...(data ? JSON.parse(data) : {}) };
    });
    expect(events.some((event) => event.event === 'approval_required')).toBe(true);
    const approval = events.find((event) => event.event === 'approval_required')!;
    const before = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(before.body.data).toHaveLength(0);
    const approved = await request(app).post(`/api/agent/approvals/${approval.approvalId}/approve`);
    expect(approved.status).toBe(200);
    const after = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(after.body.data).toHaveLength(1);
    taskId = after.body.data[0].id;
  });

  it('restores conversation messages and pending approvals', async () => {
    const response = await request(app).post('/api/chat').send({ message: '创建任务：恢复测试', pageContext: { topicId, page: 'board' } });
    const messageStart = response.text.match(/event: message_start\ndata: (.+)/)?.[1];
    const restoredConversationId = messageStart ? JSON.parse(messageStart).conversationId : '';
    expect(restoredConversationId).toBeTruthy();
    const messages = await request(app).get(`/api/conversations/${restoredConversationId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.data.some((item: any) => item.role === 'user')).toBe(true);
    const pending = await request(app).get('/api/agent/approvals?status=pending');
    expect(pending.status).toBe(200);
    expect(pending.body.data.some((item: any) => item.status === 'pending')).toBe(true);
  });

  afterAll(async () => {
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
    if (topicId) await prisma.topic.delete({ where: { id: topicId } }).catch(() => undefined);
    await prisma.$disconnect();
  });
});
