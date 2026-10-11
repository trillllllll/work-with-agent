import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './application/workspace-store.js';

let taskId = '';
beforeAll(async () => {
  const created = await request(app).post('/api/tasks').send({ title: '专注目标' });
  taskId = created.body.data.id;
});
afterAll(async () => {
  if (taskId) await prisma.focusSession.deleteMany({ where: { taskId } });
  if (taskId) await prisma.task.deleteMany({ where: { id: taskId } });
});
describe('专注记录 API', () => {
  it('创建并查询专注记录', async () => {
    const post = await request(app).post('/api/focus-sessions')
      .send({ taskId, kind: 'focus', startedAt: '2026-10-11T14:00', endedAt: '2026-10-11T14:25', durationMinutes: 25, plannedMinutes: 25, completed: true });
    expect(post.status).toBe(200);
    expect(post.body.data.durationMinutes).toBe(25);
    const list = await request(app).get(`/api/focus-sessions?taskId=${taskId}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].startedAt).toBe('2026-10-11T14:00');
  });
  it('taskId 不存在返回 404', async () => {
    const post = await request(app).post('/api/focus-sessions')
      .send({ taskId: 'nope', startedAt: '2026-10-11T14:00', endedAt: '2026-10-11T14:25', durationMinutes: 25 });
    expect(post.status).toBe(404);
  });
  it('非法时间格式被拒绝', async () => {
    const post = await request(app).post('/api/focus-sessions')
      .send({ taskId: null, startedAt: '2026-10-11T24:00', endedAt: '2026-10-11T24:25', durationMinutes: 25 });
    expect(post.status).toBeGreaterThanOrEqual(400);
  });
});

void prisma;
