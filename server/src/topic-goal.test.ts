import request from './test-auth.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';

async function clean() {
  await prisma.changeRecord.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.topic.deleteMany();
}

describe('topic goal due date', () => {
  beforeEach(clean);
  afterAll(clean);

  it('creates, updates and clears the goal deadline with calendar validation', async () => {
    const created = await request(app).post('/api/topics').send({ name: '年度整理', goal: '完成全部整理', goalDueDate: '2026-12-31' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.data).toMatchObject({ goal: '完成全部整理', goalDueDate: '2026-12-31' });

    const moved = await request(app).patch(`/api/topics/${created.body.data.id}`).send({ goalDueDate: '2027-01-15' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.goalDueDate).toBe('2027-01-15');

    const cleared = await request(app).patch(`/api/topics/${created.body.data.id}`).send({ goalDueDate: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.goalDueDate).toBeNull();

    const bad = await request(app).patch(`/api/topics/${created.body.data.id}`).send({ goalDueDate: '2026-02-30' });
    expect(bad.status).toBe(400);
  });

  it('carries the goal deadline through hub sync rows', async () => {
    const created = await request(app).post('/api/topics').send({ name: '同步目标', goalDueDate: '2026-11-30' });
    expect(created.status).toBe(200);
    const row = await prisma.$transaction(async (tx) => {
      const { readLive } = await import('./application/sync-log.js');
      return readLive(tx, 'topic', created.body.data.id);
    });
    expect(row.row).toMatchObject({ goalDueDate: '2026-11-30' });
  });
});
