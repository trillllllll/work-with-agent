import request from './test-auth.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma, ToolService } from './services.js';

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
  return response.body.data;
}
async function task(input: Record<string, unknown> = {}) {
  const response = await request(app).post('/api/tasks').send({ title: '任务', ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.meta.changeId).toBeTruthy();
  return response.body.data;
}
async function get(id: string) {
  const response = await request(app).get(`/api/tasks/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}
async function patch(id: string, input: Record<string, unknown>) {
  const response = await request(app).patch(`/api/tasks/${id}`).send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}
async function tag(name = '标签') {
  const response = await request(app).post('/api/tags').send({ name });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

describe('basic Todo shared business contracts', () => {
  beforeEach(clean);
  afterAll(clean);

  it('keeps omitted fields and assignment history unchanged, and explicitly clears nullable fields and tags', async () => {
    const list = await topic();
    const label = await tag();
    const item = await task({ topicId: list.id, title: '原题', dueDate: '2028-02-29', tagIds: [label.id] });
    await patch(item.id, { title: '新题' });
    expect(await get(item.id)).toMatchObject({ topicId: list.id, dueDate: '2028-02-29', tagIds: [label.id] });
    const history = (await request(app).get(`/api/tasks/${item.id}/topic-history`)).body.data;
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('created');
    const cleared = await patch(item.id, { topicId: null, dueDate: null, tagIds: [], description: '' });
    expect(cleared.body.data).toMatchObject({ topicId: null, dueDate: null, tagIds: [], description: '' });
    expect(cleared.body.meta.affectedTaskIds).toContain(item.id);
  });

  it('uses the same calendar, title, null and collection validation for REST and Tool writes', async () => {
    const tools = new ToolService();
    for (const invalid of [{ title: '  ' }, { title: '日期', dueDate: '2026-02-29' }, { title: '日期', dueDate: '2026-13-01' }]) {
      expect((await request(app).post('/api/tasks').send(invalid)).status).toBe(400);
      expect((await tools.execute({ name: 'create_task', arguments: invalid }, { source: 'agent' })).success).toBe(false);
    }
    const list = await topic();
    const label = await tag();
    const item = await task({ topicId: list.id, dueDate: '2028-02-29', tagIds: [label.id] });
    const cleared = await tools.execute({ name: 'update_task', arguments: { taskId: item.id, expectedRevision: item.revision, topicId: null, dueDate: null, tagIds: [] } }, { source: 'user' });
    expect(cleared.success, cleared.error).toBe(true);
    expect(await get(item.id)).toMatchObject({ topicId: null, dueDate: null, tagIds: [] });
    expect((await tools.execute({ name: 'update_task', arguments: { taskId: item.id, expectedRevision: (await get(item.id)).revision, status: 'done' } }, { source: 'user' })).success).toBe(true);
    expect((await tools.execute({ name: 'update_task', arguments: { taskId: item.id, expectedRevision: (await get(item.id)).revision, status: 'todo' } }, { source: 'user' })).success).toBe(true);
  });

  it('completes a family atomically only after explicit choice, and reopening a child reopens its parent', async () => {
    const parent = await task({ title: '父任务' });
    const child = await task({ title: '子任务', parentId: parent.id });
    const denied = await request(app).patch(`/api/tasks/${parent.id}`).send({ status: 'done' });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('SUBTASKS_INCOMPLETE');
    expect((await get(parent.id)).status).toBe('todo');
    expect((await get(child.id)).status).toBe('todo');
    const response = await patch(parent.id, { status: 'done', completeChildren: true });
    expect(response.body.meta.affectedTaskIds).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect((await get(child.id)).status).toBe('done');
    const count = await prisma.changeRecord.count();
    await patch(child.id, { status: 'todo' });
    expect((await get(parent.id)).status).toBe('todo');
    expect(await prisma.changeRecord.count()).toBe(count + 1);
    await patch(child.id, { status: 'done' });
    expect((await get(parent.id)).status).toBe('todo');
  });

  it('enforces one level and no cycles, and moves both live and trashed children with their parent', async () => {
    const source = await topic('来源');
    const target = await topic('目标');
    const parent = await task({ topicId: source.id });
    const child = await task({ parentId: parent.id });
    const trashed = await task({ parentId: parent.id });
    expect((await get(child.id)).topicId).toBe(source.id);
    expect((await request(app).post('/api/tasks').send({ title: '孙任务', parentId: child.id })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).patch(`/api/tasks/${parent.id}`).send({ parentId: child.id })).status).toBeGreaterThanOrEqual(400);
    await request(app).delete(`/api/tasks/${trashed.id}`);
    await patch(parent.id, { topicId: target.id });
    expect((await get(child.id)).topicId).toBe(target.id);
    expect(await prisma.task.findUnique({ where: { id: trashed.id } })).toMatchObject({ topicId: target.id, parentId: parent.id });
    await patch(child.id, { topicId: source.id });
    expect(await get(child.id)).toMatchObject({ topicId: source.id, parentId: null });
  });

  it('does not resurrect children deleted before the parent deletion batch', async () => {
    const parent = await task();
    const oldDeleted = await task({ parentId: parent.id, title: '此前删除' });
    const included = await task({ parentId: parent.id, title: '本次删除' });
    await request(app).delete(`/api/tasks/${oldDeleted.id}`);
    const deletion = await request(app).delete(`/api/tasks/${parent.id}`);
    expect(deletion.status).toBe(200);
    const parentRow = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    const includedRow = await prisma.task.findUniqueOrThrow({ where: { id: included.id } });
    expect(parentRow.deleteBatchId).toBeTruthy();
    expect(includedRow.deleteBatchId).toBe(parentRow.deleteBatchId);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: oldDeleted.id } })).deleteBatchId).not.toBe(parentRow.deleteBatchId);
    expect((await request(app).post(`/api/trash/tasks/${parent.id}/restore`)).status).toBe(200);
    expect((await get(included.id)).parentId).toBe(parent.id);
    expect((await request(app).get(`/api/tasks/${oldDeleted.id}`)).status).toBe(404);
  });

  it('restores a child independently by detaching an unavailable parent', async () => {
    const parent = await task();
    const child = await task({ parentId: parent.id });
    await request(app).delete(`/api/tasks/${parent.id}`);
    expect((await request(app).post(`/api/trash/tasks/${child.id}/restore`)).status).toBe(200);
    expect((await get(child.id)).parentId).toBeNull();
    expect((await request(app).get(`/api/tasks/${parent.id}`)).status).toBe(404);
  });

  it('reopens completed parents when attaching or restoring unfinished children', async () => {
    const parent = await task();
    await patch(parent.id, { status: 'done' });
    const child = await task({ parentId: parent.id });
    expect((await get(parent.id)).status).toBe('todo');
    await request(app).delete(`/api/tasks/${child.id}`);
    await patch(parent.id, { status: 'done' });
    expect((await request(app).post(`/api/trash/tasks/${child.id}/restore`)).status).toBe(200);
    expect((await get(parent.id)).status).toBe('todo');
  });

  it('archives without unassigning, hides ordinary queries, rejects edits, and restores the list', async () => {
    const list = await topic();
    const item = await task({ topicId: list.id, dueDate: '2026-09-20' });
    expect((await request(app).post(`/api/topics/${list.id}/archive`)).status).toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: item.id } })).topicId).toBe(list.id);
    expect((await request(app).get('/api/tasks')).body.data).toHaveLength(0);
    expect((await request(app).get('/api/tasks?includeArchived=true')).body.data.map((value: any) => value.id)).toContain(item.id);
    expect((await request(app).get('/api/topics?archived=true')).body.data.map((value: any) => value.id)).toContain(list.id);
    expect((await request(app).get(`/api/topics/${list.id}?includeArchived=true`)).status).toBe(200);
    expect((await request(app).patch(`/api/tasks/${item.id}`).send({ title: '不可修改' })).status).toBe(409);
    expect((await request(app).post(`/api/topics/${list.id}/restore`)).status).toBe(200);
    expect((await get(item.id)).topicId).toBe(list.id);
    expect((await request(app).get(`/api/tasks/${item.id}/topic-history`)).body.data).toHaveLength(1);
  });

  it('restores trash into inbox when its original list is archived and returns a reason', async () => {
    const list = await topic();
    const item = await task({ topicId: list.id });
    await request(app).delete(`/api/tasks/${item.id}`);
    await request(app).post(`/api/topics/${list.id}/archive`);
    const response = await request(app).post(`/api/trash/tasks/${item.id}/restore`);
    expect(response.status).toBe(200);
    expect(response.body.data.topicId).toBeNull();
    expect(response.body.meta.warnings.length).toBeGreaterThan(0);
  });

  it('persists complete-scope ordering, rejects stale or partial sets, and leaves order unchanged on edits', async () => {
    const list = await topic();
    const first = await task({ topicId: list.id });
    const second = await task({ topicId: list.id });
    await patch(second.id, { status: 'done' });
    const scope = { topicId: list.id, parentId: null };
    expect((await request(app).post('/api/tasks/reorder').send({ ...scope, orderedTaskIds: [first.id] })).status).toBe(409);
    expect((await request(app).post('/api/tasks/reorder').send({ ...scope, orderedTaskIds: [first.id, first.id] })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post('/api/tasks/reorder').send({ ...scope, orderedTaskIds: [second.id, first.id] })).status).toBe(200);
    await patch(second.id, { title: '编辑不应改变排序' });
    const rows = (await request(app).get(`/api/tasks?topicId=${list.id}&status=all&sort=manual`)).body.data;
    expect(rows.map((value: any) => value.id)).toEqual([second.id, first.id]);
    await task({ topicId: list.id });
    expect((await request(app).post('/api/tasks/reorder').send({ ...scope, orderedTaskIds: [second.id, first.id] })).status).toBe(409);
  });

  it('combines search, status, tags and local date boundaries without returning archived or trashed items', async () => {
    const label = await tag();
    const match = await task({ title: '中文测试', dueDate: '2026-09-20', tagIds: [label.id] });
    await task({ title: '中文测试逾期', dueDate: '2026-09-19', tagIds: [label.id] });
    const done = await task({ title: '中文测试已完成', dueDate: '2026-09-20', tagIds: [label.id] });
    await patch(done.id, { status: 'done' });
    const response = await request(app).get('/api/tasks').query({ q: '中文测试', status: 'open', dueFrom: '2026-09-20', dueTo: '2026-09-20', tagIds: label.id });
    expect(response.status).toBe(200);
    expect(response.body.data.map((value: any) => value.id)).toEqual([match.id]);
    expect((await request(app).get('/api/tasks').query({ dueFrom: '2026-02-30' })).status).toBe(400);
  });

  it('undoes a grouped family move atomically with tags intact and strictly increasing revisions', async () => {
    const source = await topic('来源');
    const target = await topic('目标');
    const label = await tag();
    const parent = await task({ topicId: source.id, tagIds: [label.id] });
    const child = await task({ parentId: parent.id });
    const moved = await patch(parent.id, { topicId: target.id, tagIds: [] });
    const movedChild = await get(child.id);
    const undo = await request(app).post(`/api/changes/${moved.body.meta.changeId}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    const restoredParent = await get(parent.id);
    const restoredChild = await get(child.id);
    expect(restoredParent).toMatchObject({ topicId: source.id, tagIds: [label.id] });
    expect(restoredChild).toMatchObject({ topicId: source.id, parentId: parent.id });
    expect(restoredParent.revision).toBeGreaterThan(moved.body.data.revision);
    expect(restoredChild.revision).toBeGreaterThan(movedChild.revision);
    expect(await prisma.changeRecord.findFirst({ where: { reversalOf: moved.body.meta.changeId } })).not.toBeNull();
  });

  it('rejects an entire grouped undo after one child changes, without rolling back unaffected members', async () => {
    const source = await topic('来源');
    const target = await topic('目标');
    const parent = await task({ topicId: source.id });
    const child = await task({ parentId: parent.id });
    const moved = await patch(parent.id, { topicId: target.id });
    await patch(child.id, { title: '后来编辑' });
    const undo = await request(app).post(`/api/changes/${moved.body.meta.changeId}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('UNDO_CONFLICT');
    expect((await get(parent.id)).topicId).toBe(target.id);
    expect(await get(child.id)).toMatchObject({ topicId: target.id, title: '后来编辑' });
  });

  it('removes tag associations without deleting tasks and restores them through undo', async () => {
    const label = await tag();
    const item = await task({ tagIds: [label.id] });
    const removed = await request(app).delete(`/api/tags/${label.id}`);
    expect(removed.status).toBe(200);
    expect((await get(item.id)).tagIds).toEqual([]);
    expect((await request(app).post(`/api/changes/${removed.body.meta.changeId}/undo`)).status).toBe(200);
    expect((await get(item.id)).tagIds).toEqual([label.id]);
  });

  it('can undo a pre-migration archive snapshot without losing new task fields', async () => {
    const list = await topic();
    const label = await tag();
    const item = await task({ topicId: list.id, tagIds: [label.id] });
    const topicBefore = await prisma.topic.findUniqueOrThrow({ where: { id: list.id } });
    const taskBefore = await prisma.task.findUniqueOrThrow({ where: { id: item.id } });
    const { revision: _topicRevision, ...oldTopic } = topicBefore;
    const { revision: _revision, parentId: _parentId, sortOrder: _sortOrder, deleteBatchId: _deleteBatchId, ...oldTask } = taskBefore;
    const archivedAt = '2026-09-20T01:02:03.000Z';
    await prisma.topic.update({ where: { id: list.id }, data: { archivedAt, updatedAt: archivedAt } });
    await prisma.task.update({ where: { id: item.id }, data: { topicId: null, updatedAt: archivedAt } });
    const record = await prisma.changeRecord.create({ data: {
      entityType: 'topic', entityId: list.id, operation: 'archive', source: 'user', createdAt: archivedAt,
      beforeSnapshot: JSON.stringify({ ...oldTopic, tasks: [oldTask] }),
      afterSnapshot: JSON.stringify({ ...oldTopic, archivedAt, updatedAt: archivedAt, tasks: [{ ...oldTask, topicId: null, updatedAt: archivedAt }] }),
    } });
    const response = await request(app).post(`/api/changes/${record.id}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await request(app).get(`/api/topics/${list.id}`)).status).toBe(200);
    const restored = await get(item.id);
    expect(restored).toMatchObject({ topicId: list.id, tagIds: [label.id], sortOrder: taskBefore.sortOrder });
    expect(restored.revision).toBeGreaterThan(taskBefore.revision);
    expect(restored.updatedAt).not.toBe(taskBefore.updatedAt);
    const history = (await request(app).get(`/api/tasks/${item.id}/topic-history`)).body.data;
    expect(history.at(-1)).toMatchObject({ fromTopicId: null, toTopicId: list.id, reason: 'undo' });
  });

  it('restores a physically deleted legacy topic from an old snapshot without a revision field', async () => {
    const list = await topic('旧版已删除主题');
    const before = await prisma.topic.findUniqueOrThrow({ where: { id: list.id } });
    const { revision: _revision, archivedAt: _archivedAt, ...legacySnapshot } = before;
    await prisma.topic.delete({ where: { id: list.id } });
    const record = await prisma.changeRecord.create({ data: {
      entityType: 'topic', entityId: list.id, operation: 'delete', source: 'user', createdAt: '2026-09-01T00:00:00.000Z',
      beforeSnapshot: JSON.stringify(legacySnapshot), afterSnapshot: null,
    } });
    const response = await request(app).post(`/api/changes/${record.id}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const restored = await request(app).get(`/api/topics/${list.id}`);
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ id: list.id, name: legacySnapshot.name, description: legacySnapshot.description, archivedAt: null });
    expect(restored.body.data.revision).toBeGreaterThanOrEqual(1);
    expect(await prisma.changeRecord.findFirst({ where: { reversalOf: record.id } })).not.toBeNull();
  });

  it('restores a physically deleted legacy task from an old snapshot with safe defaults for new fields', async () => {
    const list = await topic();
    const item = await task({ topicId: list.id, title: '旧版硬删除任务', priority: 'high', dueDate: '2026-09-20' });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: item.id } });
    const { revision: _revision, parentId: _parentId, sortOrder: _sortOrder, deleteBatchId: _deleteBatchId, ...legacySnapshot } = before;
    await prisma.task.delete({ where: { id: item.id } });
    const record = await prisma.changeRecord.create({ data: {
      entityType: 'task', entityId: item.id, operation: 'delete', source: 'user', createdAt: '2026-09-01T00:00:00.000Z',
      beforeSnapshot: JSON.stringify(legacySnapshot), afterSnapshot: null,
    } });
    const response = await request(app).post(`/api/changes/${record.id}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await get(item.id)).toMatchObject({ id: item.id, topicId: list.id, title: '旧版硬删除任务', priority: 'high', dueDate: '2026-09-20', parentId: null, tagIds: [] });
  });

  it('does not undo task creation through the read-only boundary of an archived list', async () => {
    const list = await topic();
    const item = await task({ topicId: list.id });
    const creation = await prisma.changeRecord.findFirstOrThrow({ where: { entityType: 'task', entityId: item.id, operation: 'create' } });
    await request(app).post(`/api/topics/${list.id}/archive`);
    const response = await request(app).post(`/api/changes/${creation.id}/undo`);
    expect(response.status).toBe(409);
    expect(await prisma.task.findUnique({ where: { id: item.id } })).not.toBeNull();
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: list.id } })).archivedAt).not.toBeNull();
  });

  it('allows undo of the explicit archived-list move while retaining the archived list and family relationship', async () => {
    const list = await topic();
    const parent = await task({ topicId: list.id });
    const child = await task({ parentId: parent.id });
    await request(app).post(`/api/topics/${list.id}/archive`);
    const moved = await request(app).post(`/api/topics/${list.id}/move-tasks-to-inbox`);
    expect(moved.status).toBe(200);
    expect(await get(child.id)).toMatchObject({ topicId: null, parentId: parent.id });
    const undo = await request(app).post(`/api/changes/${moved.body.meta.changeId}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await prisma.task.findUnique({ where: { id: child.id } })).toMatchObject({ topicId: list.id, parentId: parent.id });
    expect(await prisma.task.findUnique({ where: { id: parent.id } })).toMatchObject({ topicId: list.id });
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: list.id } })).archivedAt).not.toBeNull();
    expect((await request(app).get('/api/tasks')).body.data).toHaveLength(0);
  });

  it('keeps one ChangeRecord per grouped request even with the unique request-id index', async () => {
    const parent = await task();
    const child = await task({ parentId: parent.id });
    const response = await request(app).patch(`/api/tasks/${parent.id}`).set('x-request-id', 'family-complete-request').send({ status: 'done', completeChildren: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await prisma.requestReceipt.count({ where: { actorId: 'local-owner', requestId: 'family-complete-request' } })).toBe(1);
    expect((await get(child.id)).status).toBe('done');
  });

  it('undoes restoring an archived trash family into Inbox without unarchiving the original list', async () => {
    const list = await topic();
    const parent = await task({ topicId: list.id });
    const child = await task({ parentId: parent.id });
    expect((await request(app).delete(`/api/tasks/${parent.id}`)).status).toBe(200);
    const deletedParent = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    const deletedChild = await prisma.task.findUniqueOrThrow({ where: { id: child.id } });
    expect((await request(app).post(`/api/topics/${list.id}/archive`)).status).toBe(200);
    const archivedList = await prisma.topic.findUniqueOrThrow({ where: { id: list.id } });

    const restored = await request(app).post(`/api/trash/tasks/${parent.id}/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.data).toMatchObject({ topicId: null, deletedAt: null });
    const restoredChild = await get(child.id);
    expect(restoredChild).toMatchObject({ topicId: null, parentId: parent.id, deletedAt: null });
    expect(await prisma.topic.findUniqueOrThrow({ where: { id: list.id } })).toMatchObject({ archivedAt: archivedList.archivedAt, revision: archivedList.revision });

    const undo = await request(app).post(`/api/changes/${restored.body.meta.changeId}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.meta.affectedTaskIds).toEqual(expect.arrayContaining([parent.id, child.id]));
    const undoneParent = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    const undoneChild = await prisma.task.findUniqueOrThrow({ where: { id: child.id } });
    expect(undoneParent).toMatchObject({ topicId: list.id, deletedAt: deletedParent.deletedAt, deleteBatchId: deletedParent.deleteBatchId });
    expect(undoneChild).toMatchObject({ topicId: list.id, parentId: parent.id, deletedAt: deletedChild.deletedAt, deleteBatchId: deletedParent.deleteBatchId });
    expect(undoneParent.revision).toBeGreaterThan(restored.body.data.revision);
    expect(undoneChild.revision).toBeGreaterThan(restoredChild.revision);
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: list.id } })).archivedAt).toBe(archivedList.archivedAt);
    expect((await request(app).get('/api/tasks')).body.data).toHaveLength(0);
  });

  it('rejects undo of an archived-trash restore when the source list changed afterwards', async () => {
    const list = await topic();
    const parent = await task({ topicId: list.id });
    const child = await task({ parentId: parent.id });
    expect((await request(app).delete(`/api/tasks/${parent.id}`)).status).toBe(200);
    expect((await request(app).post(`/api/topics/${list.id}/archive`)).status).toBe(200);
    const restored = await request(app).post(`/api/trash/tasks/${parent.id}/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const restoredChild = await get(child.id);

    // The final archived state is the same, but its version records the intervening changes.
    expect((await request(app).post(`/api/topics/${list.id}/restore`)).status).toBe(200);
    expect((await request(app).post(`/api/topics/${list.id}/archive`)).status).toBe(200);
    const undo = await request(app).post(`/api/changes/${restored.body.meta.changeId}/undo`);
    expect(undo.status, JSON.stringify(undo.body)).toBe(409);
    expect(undo.body.code).toBe('UNDO_CONFLICT');
    expect(await get(parent.id)).toMatchObject({ topicId: null, deletedAt: null, revision: restored.body.data.revision });
    expect(await get(child.id)).toMatchObject({ topicId: null, parentId: parent.id, deletedAt: null, revision: restoredChild.revision });
    expect((await prisma.changeRecord.findUniqueOrThrow({ where: { id: restored.body.meta.changeId } })).undoneAt).toBeNull();
  });

  it('rejects reorder undo when a newly created task changes the ordering scope', async () => {
    const list = await topic();
    const first = await task({ topicId: list.id });
    const second = await task({ topicId: list.id });
    const sorted = await request(app).post('/api/tasks/reorder').send({ topicId: list.id, parentId: null, orderedTaskIds: [second.id, first.id] });
    expect(sorted.status).toBe(200);
    const later = await task({ topicId: list.id });
    const undo = await request(app).post(`/api/changes/${sorted.body.meta.changeId}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('UNDO_CONFLICT');
    expect((await request(app).get(`/api/tasks?topicId=${list.id}&status=all&sort=manual`)).body.data.map((value: any) => value.id)).toEqual([second.id, first.id, later.id]);
  });

  it('permanently deletes a trashed parent and all of its still-attached trashed children', async () => {
    const parent = await task();
    const earlier = await task({ parentId: parent.id });
    const current = await task({ parentId: parent.id });
    await request(app).delete(`/api/tasks/${earlier.id}`);
    await request(app).delete(`/api/tasks/${parent.id}`);
    const response = await request(app).delete(`/api/trash/tasks/${parent.id}/permanent`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await prisma.task.count({ where: { id: { in: [parent.id, earlier.id, current.id] } } })).toBe(0);
    expect((await request(app).post(`/api/changes/${response.body.meta.changeId}/undo`)).status).toBe(400);
  });
});
