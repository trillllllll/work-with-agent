import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerSession } from '../test-auth.js';
import { CommandService } from './commands.js';
import { ownerActor, actorFromConnection } from './security.js';
import { TaskService, TopicService } from './workspace.js';
import { ApprovalService } from './approval.js';

const service = new CommandService();
const taskIds: string[] = [], topicIds: string[] = [], connectionIds: string[] = [];
const materialIds: string[] = [], memoryIds: string[] = [];
async function topic(name = '命令测试清单') { const row = await new TopicService().create({ name }); topicIds.push(row.id); return row; }
async function task(topicId: string | null = null, parentId?: string) { const row = await new TaskService().create({ title: '命令测试任务', topicId, parentId }); taskIds.push(row.id); return row; }
async function owner(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) {
  const session = await ownerSession(app);
  const query = request(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return body === undefined ? query : query.send(body);
}
async function connection(topicIds: string[], autoActions: string[] = [], includeInbox = false) {
  const response = await owner('post', '/api/v1/connections', { name: '命令测试连接', host: 'codex', topicIds, autoActions, includeInbox });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  connectionIds.push(response.body.data.id);
  const row = await prisma.connection.findUniqueOrThrow({ where: { id: response.body.data.id } });
  return { ...response.body.data, actor: actorFromConnection(row) };
}
const command = (id: string, revision: number, input: Record<string, unknown>) => ({ kind: 'task.update', targetId: id, expectedRevision: revision, input });
const submit = (commands: unknown[], requestId = randomUUID(), previewToken?: string) => ({ requestId, commands, previewToken });

describe('identity, shared commands and atomic proposals', () => {
  afterAll(async () => {
    await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: memoryIds } } });
    await prisma.memory.deleteMany({ where: { id: { in: memoryIds } } });
    await prisma.materialVersion.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.material.deleteMany({ where: { id: { in: materialIds } } });
    await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.updateMany({ where: { id: { in: taskIds } }, data: { parentId: null } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
    await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
  });

  it('requires authenticated identity and CSRF and prevents external legacy impersonation', async () => {
    expect((await request(app).get('/api/tasks')).status).toBe(401);
    expect((await request(app).get('/api/v1/tasks')).status).toBe(401);
    const session = await ownerSession(app);
    expect((await request(app).post('/api/tasks').set('Cookie', session.cookie).send({ title: '不得写入' })).status).toBe(403);
    const list = await topic(), link = await connection([list.id]);
    const legacy = await request(app).post('/api/tasks').set('Authorization', `Bearer ${link.token}`).send({ title: '伪造用户', topicId: list.id, source: 'user', actor: ownerActor });
    expect(legacy.status).toBe(403);
    const external = await request(app).post('/api/v1/commands').set('Authorization', `Bearer ${link.token}`).send({ ...submit([{ kind: 'task.create', input: { title: '等待确认', topicId: list.id } }]), actor: ownerActor });
    expect(external.body.data.status).toBe('pending_approval');
    expect(await prisma.task.count({ where: { topicId: list.id } })).toBe(0);
  });

  it('applies a default proposal only on owner confirmation and replays its receipt exactly', async () => {
    const list = await topic(), item = await task(list.id), link = await connection([list.id]);
    const pending = await service.submit(link.actor, submit([command(item.id, item.revision, { title: '确认后修改' })]));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: item.id } })).title).toBe(item.title);
    const approval = { requestId: randomUUID(), expectedRevision: 1 };
    const applied = await service.approve(ownerActor, pending.proposalId, approval);
    expect(applied.results[0].title).toBe('确认后修改');
    expect(await service.approve(ownerActor, pending.proposalId, approval)).toEqual(applied);
    await expect(service.submit(ownerActor, submit([command(item.id, item.revision, { title: '旧版本' })]))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('checks every granular auto grant and serializes simultaneous identical retries', async () => {
    const list = await topic(), item = await task(list.id), link = await connection([list.id], ['task.content']);
    const input = submit([command(item.id, item.revision, { title: '一次提交' })]);
    const [first, second] = await Promise.all([service.submit(link.actor, input), service.submit(link.actor, input)]);
    expect(first.status).toBe('applied'); expect(second).toEqual(first);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: item.id } })).revision).toBe(item.revision + 1);
    await expect(service.submit(link.actor, { ...input, commands: [command(item.id, item.revision, { title: '不同参数' })] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const mixed = await service.submit(link.actor, submit([command(item.id, item.revision + 1, { title: '混合字段', dueDate: '2026-10-01' })]));
    expect(mixed.status).toBe('pending_approval');
  });

  it('never auto-applies implicit parent changes or family completion even with a valid preview', async () => {
    const list = await topic(), parent = await task(list.id);
    await new TaskService().update(parent.id, { status: 'done' });
    const link = await connection([list.id], ['task.create']);
    const create = [{ kind: 'task.create', input: { title: '需要确认的子任务', parentId: parent.id } }];
    const preview = await service.preview(link.actor, { commands: create });
    const pending = await service.submit(link.actor, submit(create, randomUUID(), preview.previewToken));
    expect(pending.status).toBe('pending_approval');
    expect(await prisma.task.count({ where: { parentId: parent.id } })).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('done');
    await new TaskService().update(parent.id, { title: '提议后已改变父任务' });
    await expect(service.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const openParent = await task(list.id), child = await task(list.id, openParent.id);
    const current = await prisma.task.findUniqueOrThrow({ where: { id: openParent.id } });
    const completionLink = await connection([list.id], ['task.complete']);
    const complete = await service.submit(completionLink.actor, submit([command(openParent.id, current.revision, { status: 'done', completeChildren: true })]));
    expect(complete.status).toBe('pending_approval');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('todo');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: openParent.id } })).status).toBe('todo');
  });

  it('enforces destination, inbox and historical receipt visibility after a task moves', async () => {
    const visible = await topic(), hidden = await topic(), item = await task(visible.id), link = await connection([visible.id], ['task.content']);
    const input = submit([command(item.id, 1, { title: '范围内' })]);
    await service.submit(link.actor, input);
    await expect(service.submit(link.actor, submit([{ kind: 'task.create', input: { title: '越界', topicId: hidden.id } }]))).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(service.submit(link.actor, submit([{ kind: 'task.create', input: { title: '收集箱越界' } }]))).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await service.submit(ownerActor, submit([command(item.id, 2, { topicId: hidden.id })]));
    await expect(service.submit(link.actor, input)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const response = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${link.token}`);
    expect(response.body.data.items.some((row: { id: string }) => row.id === item.id)).toBe(false);
  });

  it('invalidates pending approvals when connection grants change or are revoked', async () => {
    const list = await topic(), item = await task(list.id), link = await connection([list.id]);
    const pending = await service.submit(link.actor, submit([command(item.id, 1, { title: '旧权限提议' })]));
    expect((await owner('patch', `/api/v1/connections/${link.id}`, { expectedRevision: 1, autoActions: ['task.content'] })).status).toBe(200);
    await expect(service.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    expect((await owner('delete', `/api/v1/connections/${link.id}`, { expectedRevision: 2 })).status).toBe(200);
    await expect(service.submit(link.actor, submit([command(item.id, 1, { title: '撤销后提交' })]))).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  });

  it('requires a complete cascade preview and rejects a child edit after preview without partial writes', async () => {
    const parent = await task(), child = await task(null, parent.id);
    const current = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
    const commands = [command(parent.id, current.revision, { status: 'done', completeChildren: true })];
    await expect(service.submit(ownerActor, submit(commands))).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' });
    const preview = await service.preview(ownerActor, { commands });
    await new TaskService().update(child.id, { title: '预览之后编辑' });
    await expect(service.submit(ownerActor, submit(commands, randomUUID(), preview.previewToken))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('todo');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('todo');
  });

  it('creates cross-command references atomically and groups undo into one audit', async () => {
    const list = await topic();
    const commands = [{ kind: 'task.create', clientRef: 'parent', input: { title: '批次父', topicId: list.id } }, { kind: 'task.create', input: { title: '批次子', parentId: { $ref: 'parent' } } }];
    const preview = await service.preview(ownerActor, { commands });
    const result = await service.submit(ownerActor, submit(commands, randomUUID(), preview.previewToken));
    taskIds.push(...result.results.map((row: { id: string }) => row.id));
    expect(result.results[1].parentId).toBe(result.results[0].id);
    const audit = await prisma.changeRecord.findUniqueOrThrow({ where: { id: result.changeId } });
    expect(audit.operation).toBe('batch');
    await service.submit(ownerActor, submit([{ kind: 'change.undo', targetId: result.changeId, input: {} }]));
    expect(await prisma.task.count({ where: { topicId: list.id } })).toBe(0);
  });

  it('preserves trusted creation IDs while editing, rearranging, adding and removing dependent tasks', async () => {
    const list = await topic(), link = await connection([list.id]);
    const pending = await service.submit(link.actor, submit([
      { kind: 'task.create', clientRef: 'parent', input: { title: '原父任务', topicId: list.id } },
      { kind: 'task.create', clientRef: 'child', input: { title: '原子任务', parentId: { $ref: 'parent' } } },
    ]));
    const original = await service.get(ownerActor, pending.proposalId);
    const [parent, child] = original.commands;
    const edited = await service.edit(ownerActor, pending.proposalId, { expectedRevision: 1, commands: [
      { ...child, input: { ...child.input, title: '修改后的子任务' } },
      { ...parent, input: { ...parent.input, title: '修改后的父任务' } },
      { kind: 'task.create', clientRef: 'added', input: { title: '新增子任务', parentId: { $ref: 'parent' } } },
    ] });
    expect(edited.commands.map((row: { entityId: string }) => row.entityId).slice(0, 2)).toEqual([parent.entityId, child.entityId]);
    expect(edited.commands[1].input.parentId).toBe(parent.entityId);
    const withoutRemovedChild = edited.commands.filter((row: { entityId: string }) => row.entityId !== child.entityId);
    const final = await service.edit(ownerActor, pending.proposalId, { expectedRevision: 2, commands: withoutRemovedChild });
    const applied = await service.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: final.revision });
    taskIds.push(...applied.results.map((row: { id: string }) => row.id));
    expect(applied.results[0]).toMatchObject({ id: parent.entityId, title: '修改后的父任务' });
    expect(applied.results[1]).toMatchObject({ title: '新增子任务', parentId: parent.entityId });
    expect(await prisma.task.findUnique({ where: { id: child.entityId } })).toBeNull();
  });

  it('rejects forged or dangling create identities and allows explicit replacement of a dependency', async () => {
    const list = await topic(), link = await connection([list.id]);
    const pending = await service.submit(link.actor, submit([
      { kind: 'task.create', clientRef: 'parent', input: { title: '原父任务', topicId: list.id } },
      { kind: 'task.create', input: { title: '保留子任务', parentId: { $ref: 'parent' } } },
    ]));
    const original = await service.get(ownerActor, pending.proposalId);
    const [parent, child] = original.commands;
    const invalidBatches = [
      [{ ...parent, entityId: randomUUID() }, child],
      [{ ...parent, kind: 'material.create' }, child],
      [parent, { ...parent, clientRef: 'duplicate' }, child],
      [child],
    ];
    for (const commands of invalidBatches) await expect(service.edit(ownerActor, pending.proposalId, { expectedRevision: 1, commands })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect((await service.get(ownerActor, pending.proposalId)).revision).toBe(1);
    expect(await prisma.task.count({ where: { topicId: list.id } })).toBe(0);
    const edited = await service.edit(ownerActor, pending.proposalId, { expectedRevision: 1, commands: [
      { ...child, input: { ...child.input, parentId: { $ref: 'replacement' } } },
      { kind: 'task.create', clientRef: 'replacement', input: { title: '替换父任务', topicId: list.id } },
    ] });
    expect(edited.commands[0].entityId).not.toBe(parent.entityId);
    expect(edited.commands[1].entityId).toBe(child.entityId);
    const applied = await service.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: 2 });
    taskIds.push(...applied.results.map((row: { id: string }) => row.id));
    expect(applied.results[1].parentId).toBe(applied.results[0].id);
    expect(await prisma.task.findUnique({ where: { id: parent.entityId } })).toBeNull();
  });

  it('keeps material-to-memory evidence references valid after editing normalized proposal commands', async () => {
    const list = await topic(), link = await connection([list.id]);
    const pending = await service.submit(link.actor, submit([
      { kind: 'material.create', clientRef: 'source', input: { topicId: list.id, title: '材料', content: '使用本地存储' } },
      { kind: 'memory.create', input: { topicId: list.id, title: '记忆', content: '采用本地存储', evidence: [{ type: 'material', id: { $ref: 'source' }, revision: 1 }] } },
    ]));
    const original = await service.get(ownerActor, pending.proposalId);
    const [material, memory] = original.commands;
    const edited = await service.edit(ownerActor, pending.proposalId, { expectedRevision: 1, commands: [
      { ...memory, input: { ...memory.input, title: '确认后的记忆' } },
      { ...material, input: { ...material.input, title: '确认后的材料' } },
    ] });
    expect(edited.commands[0].entityId).toBe(material.entityId);
    expect(edited.commands[1].entityId).toBe(memory.entityId);
    expect(edited.commands[1].input.evidence[0].id).toBe(material.entityId);
    const applied = await service.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: 2 });
    materialIds.push(applied.results[0].id); memoryIds.push(applied.results[1].id);
    expect(applied.results[0]).toMatchObject({ id: material.entityId, title: '确认后的材料' });
    expect(applied.results[1]).toMatchObject({ id: memory.entityId, title: '确认后的记忆', evidence: [expect.objectContaining({ id: material.entityId })] });
  });

  it('rolls back a failed command group including receipt and audit', async () => {
    const list = await topic(), first = await task(list.id), second = await task(list.id);
    const requestId = randomUUID();
    await expect(service.submit(ownerActor, submit([command(first.id, 1, { title: '不可部分保存' }), command(second.id, 999, { title: '过期' })], requestId))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).title).toBe(first.title);
    expect(await prisma.requestReceipt.count({ where: { requestId } })).toBe(0);
  });

  it('routes legacy mutations through CAS, receipts and the same summary/undo handlers', async () => {
    const list = await topic(), item = await task(list.id);
    expect((await owner('patch', `/api/tasks/${item.id}`, { title: '无版本' })).status).toBe(428);
    const saved = await owner('patch', `/api/tasks/${item.id}`, { title: '新标题', expectedRevision: 1 });
    expect(saved.status).toBe(200); expect(saved.body.data.revision).toBe(2);
    const summary = await owner('post', `/api/topics/${list.id}/summary/generate`, { expectedRevision: 1, summary: '成果草稿' });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.data.draftSummary).toBe('成果草稿');
    const undone = await owner('post', `/api/changes/${summary.body.meta.changeId}/undo`, {});
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: list.id } })).draftSummary).toBe('');
  });

  it('requires the internal model revision and explicitly previews migrated approvals before confirmation', async () => {
    const item = await task();
    const approvals = new ApprovalService();
    await expect(approvals.create({ name: 'update_task', arguments: { taskId: item.id, title: '不得偷偷读取新版本' } })).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    const legacy = await prisma.approval.create({ data: { toolName: 'update_task', arguments: JSON.stringify({ taskId: item.id, title: '迁移后确认' }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect((await owner('post', `/api/agent/approvals/${legacy.id}/approve`)).body.code).toBe('APPROVAL_REPREVIEW_REQUIRED');
    const preview = await owner('post', `/api/agent/approvals/${legacy.id}/preview`);
    expect(preview.status).toBe(200); expect(preview.body.data.preview).toHaveLength(1);
    const result = await owner('post', `/api/agent/approvals/${legacy.id}/approve`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const audit = await prisma.changeRecord.findFirstOrThrow({ where: { approvalId: legacy.id } });
    expect(audit).toMatchObject({ actorId: 'builtin-agent', source: 'agent', proposalId: preview.body.data.proposalId });
    await prisma.approval.delete({ where: { id: legacy.id } });
  });
});
