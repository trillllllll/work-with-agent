import { describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { ownerActor, type Actor } from './application/security.js';
import { queryTaskActivity, taskActivity } from './application/task-activity.js';
import { DomainError } from './domain/task.js';

const api = request(app);
const now = () => new Date().toISOString();
const secretToken = 'activity-secret-token';

function taskSnap(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, description: '', status: 'todo', priority: 'none', dueDate: null, scheduledStart: null, scheduledEnd: null, estimatedMinutes: null, resultSummary: '', topicId: null, parentId: null, tagIds: [], deletedAt: null, ...extra };
}

async function insertTask(title: string, topicId: string | null = null, createdAt = now()) {
  return prisma.task.create({ data: { title, topicId, description: '', createdAt, updatedAt: createdAt } });
}

async function record(input: { taskId: string; before: unknown; after: unknown; source?: string; actorId?: string | null; approvedByActorId?: string | null; createdAt?: string; operation?: string; entityId?: string }) {
  return prisma.changeRecord.create({
    data: {
      entityType: 'task',
      entityId: input.entityId ?? input.taskId,
      operation: input.operation ?? 'update',
      beforeSnapshot: JSON.stringify(input.before),
      afterSnapshot: JSON.stringify(input.after),
      source: input.source ?? 'user',
      actorId: input.actorId === undefined ? 'local-owner' : input.actorId,
      approvedByActorId: input.approvedByActorId ?? null,
      createdAt: input.createdAt ?? now(),
    },
  });
}

describe('task activity truthfulness', () => {
  it('matches the tool and the task page, and does not treat a synthetic create as the user', async () => {
    const task = await insertTask(`动态样本-${Date.now()}`);
    const saved = await record({
      taskId: task.id,
      before: taskSnap(task.id, '旧标题', { description: `token=${secretToken}` }),
      after: taskSnap(task.id, '新标题', { description: '公开说明' }),
      source: 'agent',
      actorId: 'builtin-agent',
      approvedByActorId: 'local-owner',
    });
    const toolPage = await queryTaskActivity(ownerActor, { taskId: task.id, from: null });
    const uiEvents = await taskActivity(ownerActor, task.id);
    const toolEvent = toolPage.items.find((item) => item.id === saved.id);
    const uiEvent = uiEvents.find((item) => item.id === saved.id);
    expect(toolEvent?.changes).toEqual(uiEvent?.changes);
    expect(JSON.stringify(toolPage)).not.toContain(secretToken);
    expect(toolPage.items.find((item) => item.evidence === 'task_created_at')).toMatchObject({
      evidence: 'task_created_at',
      actor: { kind: 'unknown', name: '未记录' },
    });
    expect(toolEvent).toMatchObject({ actor: { kind: 'agent', name: 'AI' }, approvedBy: { kind: 'user', name: '你' } });
  });

  it('pages real records, rejects a stale cursor, and ignores pure reordering', async () => {
    const task = await insertTask(`分页样本-${Date.now()}`);
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const saved = await record({
        taskId: task.id,
        before: taskSnap(task.id, `分页 ${index}`),
        after: taskSnap(task.id, `分页 ${index + 1}`),
        createdAt: new Date(Date.now() - index * 60_000).toISOString(),
      });
      ids.push(saved.id);
    }
    const firstPage = await queryTaskActivity(ownerActor, { taskId: task.id, from: null, limit: 20 });
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await queryTaskActivity(ownerActor, { taskId: task.id, from: null, limit: 20, cursor: firstPage.nextCursor! });
    const firstIds = firstPage.items.map((item) => item.id);
    const secondIds = secondPage.items.map((item) => item.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
    await record({ taskId: task.id, before: taskSnap(task.id, '分页后'), after: taskSnap(task.id, '分页失效') });
    await expect(queryTaskActivity(ownerActor, { taskId: task.id, from: null, cursor: firstPage.nextCursor! })).rejects.toBeInstanceOf(DomainError);
    await expect(queryTaskActivity(ownerActor, { taskId: task.id, from: null, cursor: firstPage.nextCursor! })).rejects.toMatchObject({ code: 'CURSOR_STALE' });

    const list = await api.post('/api/topics').send({ name: `排序动态-${Date.now()}` });
    const first = await api.post('/api/tasks').send({ topicId: list.body.data.id, title: '排序甲' });
    const second = await api.post('/api/tasks').send({ topicId: list.body.data.id, title: '排序乙' });
    const before = await queryTaskActivity(ownerActor, { taskId: first.body.data.id, from: null });
    const reordered = await api.post('/api/tasks/reorder').send({ topicId: list.body.data.id, parentId: null, orderedTaskIds: [second.body.data.id, first.body.data.id] });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    const afterReorder = await queryTaskActivity(ownerActor, { taskId: first.body.data.id, from: null });
    expect(afterReorder.items).toEqual(before.items);
    expect(ids.length).toBe(21);
  });

  it('reads a child out of a parent group snapshot, hides other tasks, and reports coverage limits', async () => {
    const visibleTopic = await api.post('/api/topics').send({ name: `可见清单-${Date.now()}` });
    const hiddenTopic = await api.post('/api/topics').send({ name: `隐藏清单-${Date.now()}` });
    const hiddenTitle = `隐藏任务标题-${Date.now()}`;
    const hidden = await insertTask(hiddenTitle, hiddenTopic.body.data.id);
    const child = await insertTask(`子任务动态-${Date.now()}`, visibleTopic.body.data.id);
    const parent = await insertTask(`父任务动态-${Date.now()}`, visibleTopic.body.data.id);
    await record({
      taskId: child.id,
      entityId: parent.id,
      before: { entities: { tasks: { [child.id]: taskSnap(child.id, child.title, { topicId: visibleTopic.body.data.id }), [hidden.id]: taskSnap(hidden.id, hiddenTitle, { topicId: hiddenTopic.body.data.id }) }, topics: {}, tags: {} } },
      after: { entities: { tasks: { [child.id]: taskSnap(child.id, child.title, { topicId: visibleTopic.body.data.id, status: 'done' }), [hidden.id]: taskSnap(hidden.id, hiddenTitle, { topicId: hiddenTopic.body.data.id, status: 'done' }) }, topics: {}, tags: {} } },
    });
    const nested = await insertTask(`嵌套动态-${Date.now()}`);
    await record({
      taskId: nested.id,
      before: { snapshot: JSON.stringify(taskSnap(nested.id, '嵌套旧标题')) },
      after: { snapshot: taskSnap(nested.id, '嵌套新标题') },
    });
    const broken = await insertTask(`损坏动态-${Date.now()}`);
    await prisma.changeRecord.create({ data: { entityType: 'task', entityId: broken.id, operation: 'update', beforeSnapshot: `{"id":"${broken.id}"`, afterSnapshot: `{"id":"${broken.id}"`, source: 'user', actorId: 'local-owner', createdAt: now() } });
    const old = await insertTask(`超窗动态-${Date.now()}`, null, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());
    const oldRecord = await record({ taskId: old.id, before: taskSnap(old.id, '四十天前'), after: taskSnap(old.id, '四十天后'), createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() });
    await record({ taskId: old.id, before: taskSnap(old.id, '坏时间'), after: taskSnap(old.id, '仍然坏时间但标题变了'), createdAt: 'not-a-time' });

    const childPage = await queryTaskActivity(ownerActor, { taskId: child.id, from: null });
    expect(childPage.items.some((item) => item.changes.some((change) => change.field === 'status' && change.after === 'done'))).toBe(true);
    expect(JSON.stringify(childPage)).not.toContain(hiddenTitle);
    const nestedPage = await queryTaskActivity(ownerActor, { taskId: nested.id, from: null });
    expect(nestedPage.items.some((item) => item.changes.some((change) => change.field === 'title' && change.after === '嵌套新标题'))).toBe(true);
    const brokenPage = await queryTaskActivity(ownerActor, { taskId: broken.id, from: null });
    expect(brokenPage.coverage.skippedUnreadableRecords).toBeGreaterThan(0);
    const recent = await queryTaskActivity(ownerActor, { taskId: old.id });
    expect(recent.items.map((item) => item.id)).not.toContain(oldRecord.id);
    const full = await queryTaskActivity(ownerActor, { taskId: old.id, from: null });
    expect(full.items.map((item) => item.id)).toContain(oldRecord.id);
    expect(full.coverage.unknownTimeRecords).toBeGreaterThan(0);
    const limited: Actor = { id: 'activity-limited', kind: 'user', topicIds: [visibleTopic.body.data.id], includeInbox: false, autoActions: [], revision: 1 };
    await expect(queryTaskActivity(limited, { taskId: hidden.id, from: null })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const masked = await queryTaskActivity(limited, { taskId: child.id, from: null });
    expect(JSON.stringify(masked)).not.toContain(hiddenTitle);
  });
});
