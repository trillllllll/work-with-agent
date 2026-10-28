import request from '../test-auth.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { fireDueReminders, reminderFireAt } from './reminders.js';

const zone = { leadMinutes: 10, allDayTime: '09:00', timeZone: 'Asia/Shanghai' };

async function clean() {
  await prisma.reminderFire.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.appSetting.deleteMany();
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
  return response.body.data as { id: string };
}
async function get(id: string) {
  const response = await request(app).get(`/api/tasks/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { reminderMinutesBefore: number | null };
}
const at = (utc: string) => new Date(`${utc}Z`);
const fires = () => prisma.reminderFire.findMany({ orderBy: { firedAt: 'asc' } });

describe('reminderFireAt', () => {
  it('leads the start time by the task tier or the workspace default', () => {
    const point = { scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15', reminderMinutesBefore: null as number | null };
    expect(reminderFireAt(point, zone)!.at.toISOString()).toBe('2026-01-15T00:50:00.000Z');
    expect(reminderFireAt({ ...point, reminderMinutesBefore: 0 }, zone)!.at.toISOString()).toBe('2026-01-15T01:00:00.000Z');
    expect(reminderFireAt({ ...point, reminderMinutesBefore: -1 }, zone)).toBeNull();
    expect(reminderFireAt({ ...point, reminderMinutesBefore: 1440 }, zone)!.at.toISOString()).toBe('2026-01-14T01:00:00.000Z');
  });
  it('reminds all-day tasks at the configured local time and skips tasks without a date', () => {
    expect(reminderFireAt({ dueDate: '2026-01-15', scheduledStart: null, reminderMinutesBefore: null }, zone)!.at.toISOString()).toBe('2026-01-15T00:50:00.000Z');
    expect(reminderFireAt({ scheduledStart: null, dueDate: null }, zone)).toBeNull();
  });
  it('resolves DST through the workspace zone', () => {
    // 2026-07-01 09:00 Asia/Shanghai is 01:00 UTC; the same wall time in Sydney (UTC+10 in winter) is 23:00 UTC the day before.
    const sydney = { ...zone, timeZone: 'Australia/Sydney' };
    expect(reminderFireAt({ scheduledStart: '2026-07-01T09:00', dueDate: null, reminderMinutesBefore: 0 }, sydney)!.at.toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });
});

describe('reminder firing', () => {
  beforeEach(clean);
  afterAll(clean);

  it('fires once inside the window, stays idempotent, and skips opted-out, done and dateless tasks', async () => {
    const due = await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15' });
    await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15', reminderMinutesBefore: -1 });
    const done = await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15' });
    await request(app).patch(`/api/tasks/${done.id}`).send({ status: 'done' });
    await task({ title: '没有时间' });
    const now = at('2026-01-15T00:50:30');
    const fired = await fireDueReminders(now, 90_000);
    expect(fired.map(({ taskId }) => taskId)).toEqual([due.id]);
    expect((await fires()).length).toBe(1);
    expect(await fireDueReminders(now, 90_000)).toEqual([]);
    expect((await fires()).length).toBe(1);
  });

  it('uses the per-task tier over the default and refires after a reschedule or tier change', async () => {
    const early = await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15', reminderMinutesBefore: 60 });
    const first = await fireDueReminders(at('2026-01-15T00:00:30'), 90_000);
    expect(first.map(({ taskId }) => taskId)).toEqual([early.id]);
    // Same anchor, different lead: a new fire key, still inside its own window.
    await request(app).patch(`/api/tasks/${early.id}`).send({ reminderMinutesBefore: 30 });
    const second = await fireDueReminders(at('2026-01-15T00:30:30'), 90_000);
    expect(second.map(({ taskId }) => taskId)).toEqual([early.id]);
    expect((await fires()).length).toBe(2);
    // The same anchor with the original lead stays fired even after the tier moved on and back.
    await request(app).patch(`/api/tasks/${early.id}`).send({ reminderMinutesBefore: 60 });
    expect(await fireDueReminders(at('2026-01-15T00:00:40'), 90_000)).toEqual([]);
    expect((await fires()).length).toBe(2);
  });

  it('honors a changed workspace default for follow-default tasks', async () => {
    const patch = await request(app).patch('/api/settings/reminders').send({ leadMinutes: 30 });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15' });
    const fired = await fireDueReminders(at('2026-01-15T00:30:30'), 90_000);
    expect(fired.length).toBe(1);
    expect(fired[0].lead).toBe(30);
  });

  it('does not replay reminders whose task already started, and gates the follow default behind settings', async () => {
    await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15', reminderMinutesBefore: 5 });
    // The 5-minute lead fired 08:55, but by 09:10 the task started long ago: no replay.
    const fired = await fireDueReminders(at('2026-01-15T01:10:00'), 120 * 60_000);
    expect(fired).toEqual([]);
    expect((await fires()).length).toBe(0);
  });

  it('keeps reminders out of archived lists and fires all-day tasks at the configured time', async () => {
    const allDay = await task({ dueDate: '2026-01-15' });
    const list = await request(app).post('/api/topics').send({ name: '归档清单' });
    expect(list.status).toBe(200);
    const topicId = list.body.data.id as string;
    await task({ dueDate: '2026-01-15', topicId });
    await prisma.topic.update({ where: { id: topicId }, data: { archivedAt: new Date().toISOString() } });
    const fired = await fireDueReminders(at('2026-01-15T00:50:30'), 90_000);
    expect(fired.map(({ taskId }) => taskId)).toEqual([allDay.id]);
  });

  it('copies the reminder tier to the next occurrence of a recurring task', async () => {
    const origin = await task({ scheduledStart: '2026-01-15T09:00', dueDate: '2026-01-15', reminderMinutesBefore: 30, recurrenceRule: '{"unit":"week","step":1}' });
    const response = await request(app).patch(`/api/tasks/${origin.id}`).send({ status: 'done' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const nextId = (response.body.meta.affectedTaskIds as string[]).find((id) => id !== origin.id)!;
    expect(await get(nextId)).toMatchObject({ reminderMinutesBefore: 30 });
  });
});
