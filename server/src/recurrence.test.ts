import request from './test-auth.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { canonicalRecurrenceRuleText, nextRecurrenceDate, parseRecurrenceRule, recurrenceAnchor, recurrenceRuleText } from './domain/recurrence.js';

async function clean() {
  await prisma.changeRecord.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.topic.deleteMany();
}
async function task(input: Record<string, unknown> = {}) {
  const response = await request(app).post('/api/tasks').send({ title: '任务', ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}
async function get(id: string) {
  const response = await request(app).get(`/api/tasks/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

describe('recurrence domain math', () => {
  it('steps day, week and month units on calendar dates', () => {
    const week = { unit: 'week' as const, step: 1 };
    expect(nextRecurrenceDate(week, '2026-10-20')).toBe('2026-10-27');
    expect(nextRecurrenceDate({ unit: 'day', step: 3 }, '2026-02-27')).toBe('2026-03-02');
    expect(nextRecurrenceDate({ unit: 'month', step: 1 }, '2026-01-15')).toBe('2026-02-15');
  });
  it('clamps month steps to the last day and anchors further steps on the clamped date', () => {
    expect(nextRecurrenceDate({ unit: 'month', step: 1 }, '2026-01-31')).toBe('2026-02-28');
    expect(nextRecurrenceDate({ unit: 'month', step: 1 }, '2024-01-31')).toBe('2024-02-29');
    const chained = nextRecurrenceDate({ unit: 'month', step: 1 }, nextRecurrenceDate({ unit: 'month', step: 1 }, '2026-01-31'));
    expect(chained).toBe('2026-03-28');
  });
  it('parses, rejects and canonicalizes rule text', () => {
    expect(parseRecurrenceRule('')).toBeNull();
    expect(parseRecurrenceRule(recurrenceRuleText({ unit: 'week', step: 2 }))).toEqual({ unit: 'week', step: 2 });
    for (const bad of ['{', 'null', '{"unit":"year","step":1}', '{"unit":"day","step":0}', '{"unit":"day","step":366}']) {
      expect(() => parseRecurrenceRule(bad)).toThrow();
    }
    expect(canonicalRecurrenceRuleText('{ "step": 2, "unit": "week" }')).toBe('{"unit":"week","step":2}');
  });
  it('prefers the planned date and falls back to completion day', () => {
    expect(recurrenceAnchor('2026-10-20', '2026-10-21T09:00', '2026-10-26')).toBe('2026-10-20');
    expect(recurrenceAnchor(null, '2026-10-21T09:00', '2026-10-26')).toBe('2026-10-21');
    expect(recurrenceAnchor(null, null, '2026-10-26')).toBe('2026-10-26');
  });
});

describe('recurring task completion', () => {
  beforeEach(clean);
  afterAll(clean);

  it('spawns the next occurrence in the same change when completing', async () => {
    const origin = await task({ title: '周报', dueDate: '2026-10-20', recurrenceRule: '{"unit":"week","step":1}', priority: 'high', estimatedMinutes: 30 });
    const response = await request(app).patch(`/api/tasks/${origin.id}`).send({ status: 'done' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.meta.affectedTaskIds).toEqual(expect.arrayContaining([origin.id]));
    expect(response.body.meta.affectedTaskIds!.length).toBeGreaterThan(1);
    const next = await get(response.body.meta.affectedTaskIds!.find((id: string) => id !== origin.id)!);
    expect(next).toMatchObject({ title: '周报', status: 'todo', dueDate: '2026-10-27', priority: 'high', estimatedMinutes: 30, recurrenceRule: '{"unit":"week","step":1}', topicId: origin.topicId, completedAt: null });
    expect((await get(origin.id)).status).toBe('done');
    const rows = await prisma.task.findMany({ where: { title: '周报', deletedAt: null } });
    expect(rows).toHaveLength(2);
  });

  it('keeps the planned cadence when completed late and shifts time ranges whole', async () => {
    const origin = await task({ dueDate: '2026-10-01', scheduledStart: '2026-10-01T09:00', scheduledEnd: '2026-10-01T10:30', recurrenceRule: '{"unit":"month","step":1}' });
    await prisma.task.update({ where: { id: origin.id }, data: { dueDate: '2026-10-01' } });
    const response = await request(app).patch(`/api/tasks/${origin.id}`).send({ status: 'done' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const nextId = response.body.meta.affectedTaskIds!.find((id: string) => id !== origin.id);
    expect(await get(nextId)).toMatchObject({ dueDate: '2026-11-01', scheduledStart: '2026-11-01T09:00', scheduledEnd: '2026-11-01T10:30' });
  });

  it('anchors on the completion day when no date was planned', async () => {
    const origin = await task({ recurrenceRule: '{"unit":"day","step":2}' });
    const response = await request(app).patch(`/api/tasks/${origin.id}`).send({ status: 'done' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const nextId = response.body.meta.affectedTaskIds!.find((id: string) => id !== origin.id);
    const next = await get(nextId);
    const today = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const expected = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(next.dueDate).toBe(expected);
  });

  it('copies tags and subtask parent, reopens the done parent, and does not copy children', async () => {
    const tag = (await request(app).post('/api/tags').send({ name: '标签' })).body.data;
    const parent = await task({ title: '父级', dueDate: '2026-10-05', recurrenceRule: '{"unit":"week","step":1}' });
    await request(app).patch(`/api/tasks/${parent.id}`).send({ tagIds: [tag.id] });
    const child = await task({ title: '子任务', parentId: parent.id });
    const response = await request(app).patch(`/api/tasks/${parent.id}`).send({ status: 'done', completeChildren: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const nextId = response.body.meta.affectedTaskIds!.find((id: string) => id !== parent.id && id !== child.id);
    const next = await get(nextId);
    expect(next).toMatchObject({ parentId: null, tagIds: [tag.id], topicId: parent.topicId });
    expect((await get(child.id)).status).toBe('done');
  });

  it('does not spawn without a rule, when clearing the rule in the same patch, or on plain updates', async () => {
    const plain = await task({ dueDate: '2026-10-20' });
    await request(app).patch(`/api/tasks/${plain.id}`).send({ status: 'done' });
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(1);

    const cleared = await task({ dueDate: '2026-10-20', recurrenceRule: '{"unit":"day","step":1}' });
    await request(app).patch(`/api/tasks/${cleared.id}`).send({ status: 'done', recurrenceRule: '' });
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(2);

    const reopened = await task({ recurrenceRule: '{"unit":"day","step":1}' });
    await request(app).patch(`/api/tasks/${reopened.id}`).send({ priority: 'high' });
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(3);
  });

  it('undoing the completion removes the spawned occurrence with it', async () => {
    const origin = await task({ title: '可撤销', dueDate: '2026-10-20', recurrenceRule: '{"unit":"week","step":1}' });
    const done = await request(app).patch(`/api/tasks/${origin.id}`).send({ status: 'done' });
    expect(done.status).toBe(200);
    const nextId = done.body.meta.affectedTaskIds!.find((id: string) => id !== origin.id);
    expect(await get(nextId)).toBeTruthy();
    const undo = await request(app).post(`/api/changes/${done.body.meta.changeId}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await prisma.task.findUnique({ where: { id: nextId } })).toBeNull();
    expect((await get(origin.id)).status).toBe('todo');
  });

  it('validates rule text for REST and keeps unknown fields out', async () => {
    const bad = await request(app).post('/api/tasks').send({ title: '坏规则', recurrenceRule: '{"unit":"hour","step":1}' });
    expect(bad.status).toBe(400);
    const created = await task({ recurrenceRule: '{ "step": 3, "unit": "day" }' });
    expect(created.recurrenceRule).toBe('{"unit":"day","step":3}');
  });
});
