import request from '../test-auth.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ChangeGroup, legacyTaskSnapshot, withoutLegacyTaskKeys } from './workspace-store.js';
import { writeLive } from './sync-log.js';
import { syncFields, type SyncRow } from './sync-merge.js';

async function clean() {
  await prisma.changeRecord.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.topic.deleteMany();
}
async function topic(name = '清单') {
  const response = await request(app).post('/api/topics').send({ name });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string };
}
async function task(input: Record<string, unknown> = {}) {
  const response = await request(app).post('/api/tasks').send({ title: '任务', ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number };
}
async function tag(name = '标签') {
  const response = await request(app).post('/api/tags').send({ name });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string };
}
async function patch(id: string, input: Record<string, unknown>) {
  const response = await request(app).patch(`/api/tasks/${id}`).send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}
function row(id: string) {
  return prisma.task.findUniqueOrThrow({ where: { id } });
}
function filled(patch: Record<string, unknown>): SyncRow {
  const value: SyncRow = {};
  for (const field of syncFields.task) value[field] = field === 'tagIds' ? [] : null;
  return { ...value, title: '', description: '', status: 'todo', priority: 'none', resultSummary: '', recurrenceRule: '', sortOrder: 0, ...patch };
}
function stripCompletionKeys(raw: string | null) {
  if (!raw) return raw;
  const parsed = JSON.parse(raw) as { entities?: { tasks?: Record<string, Record<string, unknown> | null> } };
  for (const task of Object.values(parsed.entities?.tasks ?? {})) {
    if (!task) continue;
    delete task.completedAt;
    delete task.completedAtEstimated;
  }
  return JSON.stringify(parsed);
}
async function stripRecord(id: string) {
  const record = await prisma.changeRecord.findUniqueOrThrow({ where: { id } });
  await prisma.changeRecord.update({ where: { id }, data: { beforeSnapshot: stripCompletionKeys(record.beforeSnapshot), afterSnapshot: stripCompletionKeys(record.afterSnapshot) } });
}

describe('task completedAt', () => {
  beforeEach(clean);
  afterAll(clean);

  it('drops completion keys only when the expected snapshot never had them', () => {
    const current = { id: 't', status: 'done', updatedAt: 'u', completedAt: 'c', completedAtEstimated: false, recurrenceRule: '', tagIds: [] as string[] };
    const expected = { id: 't', status: 'done', updatedAt: 'u', tagIds: [] as string[] };
    expect(withoutLegacyTaskKeys(current)).not.toHaveProperty('completedAt');
    expect(withoutLegacyTaskKeys(current)).not.toHaveProperty('recurrenceRule');
    expect(JSON.stringify(legacyTaskSnapshot(expected, current))).toBe(JSON.stringify(expected));
    // A snapshot from the completedAt era but before recurrenceRule keeps the completion pair and drops only the newer column.
    const midEra = legacyTaskSnapshot({ ...expected, completedAt: null }, current)!;
    expect(midEra).toMatchObject({ completedAt: 'c', completedAtEstimated: false });
    expect(midEra).not.toHaveProperty('recurrenceRule');
    expect(legacyTaskSnapshot({ ...expected, completedAt: null, recurrenceRule: '' }, current)).toBe(current);
  });

  it('writes completedAt when a task becomes done and keeps it across title, tag, and order edits', async () => {
    const list = await topic();
    const label = await tag();
    const item = await task({ topicId: list.id, title: '原题' });
    const other = await task({ topicId: list.id, title: '另一件' });
    await patch(item.id, { status: 'doing' });
    expect(await row(item.id)).toMatchObject({ status: 'doing', completedAt: null, completedAtEstimated: false });
    const completed = await patch(item.id, { status: 'done' });
    const done = await row(item.id);
    expect(done.completedAt).toBe(done.updatedAt);
    expect(done.completedAtEstimated).toBe(false);
    expect(completed.body.data.completedAt).toBe(done.completedAt);

    await patch(item.id, { title: '新题' });
    const titled = await row(item.id);
    expect(titled.completedAt).toBe(done.completedAt);
    expect(titled.updatedAt > done.updatedAt).toBe(true);

    await patch(item.id, { tagIds: [label.id] });
    expect(await row(item.id)).toMatchObject({ completedAt: done.completedAt, completedAtEstimated: false });

    const reordered = await request(app).post('/api/tasks/reorder').send({ topicId: list.id, parentId: null, orderedTaskIds: [other.id, item.id] });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const sorted = await row(item.id);
    expect(sorted.completedAt).toBe(done.completedAt);
    expect(sorted.updatedAt > titled.updatedAt).toBe(true);
  });

  it('clears completedAt when completion is undone', async () => {
    const item = await task();
    const completed = await patch(item.id, { status: 'done' });
    const undone = await request(app).post(`/api/changes/${completed.body.meta.changeId}/undo`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(await row(item.id)).toMatchObject({ status: 'todo', completedAt: null, completedAtEstimated: false });
  });

  it('stamps each child when they are completed together', async () => {
    const parent = await task({ title: '父任务' });
    const child = await task({ title: '子任务', parentId: parent.id });
    const extra = await task({ title: '另一个子任务', parentId: parent.id });
    const response = await patch(parent.id, { status: 'done', completeChildren: true });
    expect(response.body.meta.affectedTaskIds).toEqual(expect.arrayContaining([parent.id, child.id, extra.id]));
    for (const id of [parent.id, child.id, extra.id]) {
      const saved = await row(id);
      expect(saved.status).toBe('done');
      expect(saved.completedAt).toBe(saved.updatedAt);
      expect(saved.completedAtEstimated).toBe(false);
    }
  });

  it('clears the parent when a new unfinished child reopens it', async () => {
    const parent = await task({ title: '父任务' });
    await patch(parent.id, { status: 'done' });
    expect((await row(parent.id)).completedAt).toBeTruthy();
    await task({ title: '新子任务', parentId: parent.id });
    expect(await row(parent.id)).toMatchObject({ status: 'todo', completedAt: null, completedAtEstimated: false });
  });

  it('clears a done parent when restoring an unfinished child reopens it', async () => {
    const parent = await task({ title: '父任务' });
    const child = await task({ title: '子任务', parentId: parent.id });
    expect((await request(app).delete(`/api/tasks/${child.id}`)).status).toBe(200);
    await patch(parent.id, { status: 'done' });
    expect((await row(parent.id)).completedAt).toEqual((await row(parent.id)).updatedAt);
    const restored = await request(app).post(`/api/trash/tasks/${child.id}/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await row(parent.id)).toMatchObject({ status: 'todo', completedAt: null, completedAtEstimated: false });
  });

  it('clears completion when the same transaction marks a task done and then reopens it', async () => {
    await prisma.task.create({ data: { id: 'twice', title: '两次写', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
    await prisma.$transaction(async (tx) => {
      const group = new ChangeGroup(tx, { source: 'user' });
      await group.task('twice', { status: 'done' });
      await group.task('twice', { status: 'todo' });
    });
    expect(await row('twice')).toMatchObject({ status: 'todo', completedAt: null, completedAtEstimated: false });
  });

  it('undoes a legacy completion snapshot and a legacy title edit', async () => {
    const item = await task({ title: '旧快照' });
    const completed = await patch(item.id, { status: 'done' });
    const done = await row(item.id);
    await stripRecord(completed.body.meta.changeId);
    const undone = await request(app).post(`/api/changes/${completed.body.meta.changeId}/undo`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(await row(item.id)).toMatchObject({ status: 'todo', title: '旧快照', completedAt: null, completedAtEstimated: false });

    await patch(item.id, { status: 'done' });
    const finished = await row(item.id);
    const renamed = await patch(item.id, { title: '改过的标题' });
    await stripRecord(renamed.body.meta.changeId);
    const restored = await request(app).post(`/api/changes/${renamed.body.meta.changeId}/undo`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await row(item.id)).toMatchObject({ status: 'done', title: '旧快照', completedAt: finished.completedAt, completedAtEstimated: false });
  });

  it('maintains completedAt when a sync write changes status', async () => {
    const doneRow = filled({ title: '同步完成', status: 'done' });
    await prisma.$transaction(async (tx) => { await writeLive(tx, 'task', 'sync-done', doneRow); });
    const created = await row('sync-done');
    expect(created.completedAt).toBe(created.updatedAt);
    expect(created.completedAtEstimated).toBe(false);
    await prisma.$transaction(async (tx) => { await writeLive(tx, 'task', 'sync-done', { ...doneRow, title: '仍完成' }); });
    const renamed = await row('sync-done');
    expect(renamed.completedAt).toBe(created.completedAt);
    expect(renamed.title).toBe('仍完成');
    expect(renamed.updatedAt).not.toBe(created.updatedAt);
    await prisma.$transaction(async (tx) => { await writeLive(tx, 'task', 'sync-done', { ...doneRow, status: 'todo' }); });
    expect(await row('sync-done')).toMatchObject({ status: 'todo', completedAt: null, completedAtEstimated: false });
    await prisma.$transaction(async (tx) => { await writeLive(tx, 'task', 'sync-todo', filled({ title: '同步待办', status: 'todo' })); });
    expect(await row('sync-todo')).toMatchObject({ completedAt: null, completedAtEstimated: false });
  });
});
