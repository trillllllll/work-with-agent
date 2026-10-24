import { withTestToolLoading } from '../agent/test-model-tools.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { AgentService, type ModelMessage } from '../agent.js';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { readStoredApproval, type BatchSuccess } from '../domain/task-batch-types.js';
import type { ProposeTaskChangesArgs } from '../domain/task-batch.js';
import { ownerSession } from '../test-auth.js';
import { replayMessages } from './conversation.js';
import { TaskService, TagService, TopicService } from './workspace.js';
import type { ToolCall } from './workspace.js';
import { ConversationService } from './conversation.js';
import { prepareTaskBatch } from './chat-task-batch.js';

const tasks = new TaskService();
const conversations = new ConversationService();
const oldTitle = '按大威的意见，修改k8s入门文档';
const checkTitle = '核对，第9节，我们怎么使用k8s';
const topicIds = new Set<string>();
const conversationIds = new Set<string>();
const tagIds = new Set<string>();
const connectionIds = new Set<string>();

async function seed() {
  const topic = await new TopicService().create({ name: `batch-test-${randomUUID()}` });
  const a = await tasks.create({ topicId: topic.id, title: oldTitle,
    priority: 'low', description: '保留已有说明', dueDate: '2026-10-12',
    scheduledStart: '2026-10-12T12:50', scheduledEnd: '2026-10-12T13:20',
    estimatedMinutes: 30 });
  const b = await tasks.create({ topicId: topic.id, parentId: a.id, title: checkTitle,
    dueDate: '2026-10-12', scheduledStart: '2026-10-12T15:00',
    scheduledEnd: '2026-10-12T16:00' });
  const conversation = await conversations.create();
  const user = await conversations.addMessage(conversation.id, 'user',
    '新建父任务用原标题，原任务改名执行修改，两个任务作为并列子级');
  const assistant = await conversations.addMessage(conversation.id, 'assistant', '准备整组修改');
  const rows = await prisma.task.findMany({ where: { topicId: topic.id }, orderBy: { id: 'asc' } });
  const A = rows.find((x) => x.id === a.id)!;
  const B = rows.find((x) => x.id === b.id)!;
  const args = { summary: '整组调整', operations: [
    { kind: 'task.create' as const, clientRef: 'parent', input: { title: oldTitle, topicId: topic.id } },
    { kind: 'task.update' as const, targetId: A.id, expectedRevision: A.revision,
      input: { title: '执行修改', parentId: { $ref: 'parent' } } },
    { kind: 'task.update' as const, targetId: B.id, expectedRevision: B.revision,
      input: { parentId: { $ref: 'parent' } } },
  ] };
  const callId = `call-${randomUUID()}`;
  await conversations.updateMessage(assistant.id, { toolCalls: JSON.stringify([
    { id: callId, type: 'function', function: { name: 'propose_task_changes', arguments: JSON.stringify(args) } },
  ]) });
  topicIds.add(topic.id);
  conversationIds.add(conversation.id);
  return { topic, A, B, rows, args, conversation, assistant, user, callId };
}
type Seed = Awaited<ReturnType<typeof seed>>;
function input(f: Seed, overrides: Record<string, unknown> = {}) {
  return { conversationId: f.conversation.id, assistantMessageId: f.assistant.id,
    sourceUserMessageId: f.user.id, toolCallId: f.callId, arguments: f.args, ...overrides };
}
function preserved(t: any) {
  const { title, parentId, sortOrder, revision, updatedAt, ...rest } = t;
  return rest;
}
async function snapshot(topicId: string) {
  return prisma.task.findMany({ where: { topicId }, orderBy: { id: 'asc' } });
}
async function withCall(f: Seed, args: unknown, callId = f.callId) {
  await conversations.updateMessage(f.assistant.id, { toolCalls: JSON.stringify([
    { id: callId, type: 'function', function: { name: 'propose_task_changes', arguments: JSON.stringify(args) } },
  ]) });
  return { ...input(f), toolCallId: callId, arguments: args as ProposeTaskChangesArgs };
}
async function owner(method: 'get' | 'post', path: string, body?: Record<string, unknown>) {
  const session = await ownerSession(app);
  const query = request(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return body === undefined ? query : query.send(body);
}
function scripted(handler: (messages: ModelMessage[]) => { text?: string; toolCalls?: ToolCall[] }) {
  return { stream: withTestToolLoading(async function* (messages: ModelMessage[]) { const step = handler(messages); if (step.text) yield { text: step.text }; if (step.toolCalls?.length) yield { toolCalls: step.toolCalls }; }) } as never;
}
const call = (id: string, args: unknown): ToolCall => ({ id, name: 'propose_task_changes', arguments: args as Record<string, unknown> });
const propose = (id: string, args: { summary: string; operations: Array<Record<string, unknown>> }): ToolCall => ({
  id,
  name: 'propose_changes',
  arguments: { summary: args.summary, operations: args.operations.map((operation) => ({ family: 'workspace', command: operation })) },
});

describe('chat task batch contract', () => {
  afterAll(async () => {
    const ownedTopics = [...topicIds];
    const ownedConversations = [...conversationIds];
    const taskRows = ownedTopics.length ? await prisma.task.findMany({ where: { topicId: { in: ownedTopics } }, select: { id: true } }) : [];
    const taskIdList = taskRows.map((row) => row.id);
    const approvals = ownedConversations.length ? await prisma.approval.findMany({ where: { conversationId: { in: ownedConversations } } }) : [];
    const proposalIds = [...new Set(approvals.flatMap((approval) => {
      const read = readStoredApproval(approval.result);
      return [read.proposalId, read.legacyProposal?.proposalId].filter((id): id is string => Boolean(id));
    }))];
    const approvalIds = approvals.map((approval) => approval.id);
    if (taskIdList.length || proposalIds.length || approvalIds.length || ownedConversations.length) {
      await prisma.changeRecord.deleteMany({ where: { OR: [
        ...(taskIdList.length ? [{ entityId: { in: taskIdList } }] : []),
        ...(proposalIds.length ? [{ proposalId: { in: proposalIds } }] : []),
        ...(approvalIds.length ? [{ approvalId: { in: approvalIds } }] : []),
        ...(ownedConversations.length ? [{ conversationId: { in: ownedConversations } }] : []),
      ] } });
    }
    if (ownedConversations.length || approvalIds.length) {
      await prisma.requestReceipt.deleteMany({ where: { OR: [
        ...ownedConversations.map((id) => ({ requestId: { contains: id } })),
        ...approvalIds.map((id) => ({ requestId: `approval:${id}` })),
      ] } });
    }
    if (approvalIds.length) await prisma.approval.deleteMany({ where: { id: { in: approvalIds } } });
    if (ownedConversations.length) await prisma.message.deleteMany({ where: { conversationId: { in: ownedConversations } } });
    if (proposalIds.length) await prisma.proposal.deleteMany({ where: { id: { in: proposalIds } } });
    if (taskIdList.length) {
      await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIdList } } });
      await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: taskIdList } } });
      await prisma.task.updateMany({ where: { id: { in: taskIdList } }, data: { parentId: null } });
      await prisma.task.deleteMany({ where: { id: { in: taskIdList } } });
    }
    if (tagIds.size) await prisma.tag.deleteMany({ where: { id: { in: [...tagIds] } } });
    if (ownedTopics.length) await prisma.topic.deleteMany({ where: { id: { in: ownedTopics } } });
    if (ownedConversations.length) await prisma.conversation.deleteMany({ where: { id: { in: ownedConversations } } });
    if (connectionIds.size) await prisma.connection.deleteMany({ where: { id: { in: [...connectionIds] } } });
  });

  it('does not mutate before approval and applies all changes once', async () => {
    const f = await seed();
    const p = await prepareTaskBatch(input(f));
    expect(await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } })).toEqual(f.rows);
    expect(p.preview.operationCount).toBe(3);
    expect(p.preview.afterTasks.filter((x) => x.title === oldTitle)).toHaveLength(1);

    const agent = new AgentService();
    const first = await agent.approve(p.approvalId);
    expect(first.result.success).toBe(true);
    const rows = await prisma.task.findMany({ where: { topicId: f.topic.id } });
    expect(rows).toHaveLength(3);
    const P = rows.find((x) => x.id !== f.A.id && x.id !== f.B.id)!;
    const A = rows.find((x) => x.id === f.A.id)!;
    const B = rows.find((x) => x.id === f.B.id)!;
    expect(P).toMatchObject({ title: oldTitle, parentId: null, status: 'todo', priority: 'none',
      dueDate: null, scheduledStart: null, scheduledEnd: null, estimatedMinutes: null });
    expect(A).toMatchObject({ title: '执行修改', parentId: P.id });
    expect(B).toMatchObject({ title: checkTitle, parentId: P.id });
    expect(preserved(A)).toEqual(preserved(f.A));
    expect(preserved(B)).toEqual(preserved(f.B));
    expect(first.assistantMessage).toContain('已完成整组修改');
    expect(first.assistantMessage).toContain('执行修改');
    expect(first.assistantMessage).toContain(checkTitle);

    const snapshotRows = await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } });
    expect(await agent.approve(p.approvalId)).toEqual(first);
    expect(await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } })).toEqual(snapshotRows);
    const messages = await prisma.message.findMany({ where: { conversationId: f.conversation.id } });
    expect(messages.filter((x) => x.role === 'tool' && x.toolCallId === f.callId)).toHaveLength(1);
    expect(messages.filter((x) => x.role === 'assistant' && x.id !== f.assistant.id)).toHaveLength(1);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: p.approvalId } });
    expect(approval.status).toBe('executed');
    expect(JSON.parse(approval.result!)).toMatchObject({ kind: 'task_batch',
      proposalId: p.proposalId, toolCallId: f.callId, outcome: { success: true } });
  });

  it('detects external changes without leaving a newly created parent', async () => {
    const f = await seed(); const p = await prepareTaskBatch(input(f));
    await tasks.update(f.B.id, { description: '用户审批前改动' });
    const before = await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } });
    const response = await new AgentService().approve(p.approvalId);
    expect(response.result).toMatchObject({ success: false, code: 'VERSION_CONFLICT',
      data: { atomic: true, appliedOperationCount: 0 } });
    expect(await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(response.assistantMessage).toContain('本组未修改');
  });

  it('rejects the whole group without changing tasks', async () => {
    const f = await seed(); const p = await prepareTaskBatch(input(f));
    const response = await new AgentService().reject(p.approvalId);
    expect(response.result).toMatchObject({ success: false, code: 'USER_REJECTED' });
    expect(await prisma.task.findMany({ where: { topicId: f.topic.id }, orderBy: { id: 'asc' } })).toEqual(f.rows);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: p.approvalId } })).status).toBe('rejected');
  });

  it('S01 repeats the same prepare without a second approval', async () => {
    const f = await seed();
    const p1 = await prepareTaskBatch(input(f));
    const p2 = await prepareTaskBatch(input(f));
    expect(p2).toEqual(p1);
    expect(await prisma.approval.count({ where: { conversationId: f.conversation.id, status: 'pending', toolName: 'propose_task_changes' } })).toBe(1);
    expect(await prisma.task.count({ where: { topicId: f.topic.id } })).toBe(2);
  });

  it('S02 rejects a different payload for the same idempotency key', async () => {
    const f = await seed();
    await prepareTaskBatch(input(f));
    const changed = { ...f.args, summary: '另一组说明' };
    await expect(prepareTaskBatch({ ...input(f), arguments: changed })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('S03 concurrent approvals return one result', async () => {
    const f = await seed();
    const p = await prepareTaskBatch(input(f));
    const agent = new AgentService();
    const [r1, r2] = await Promise.all([agent.approve(p.approvalId), agent.approve(p.approvalId)]);
    expect(r1).toEqual(r2);
    const rows = await prisma.task.findMany({ where: { topicId: f.topic.id } });
    expect(rows.filter((row) => row.id !== f.A.id && row.id !== f.B.id)).toHaveLength(1);
    const messages = await prisma.message.findMany({ where: { conversationId: f.conversation.id } });
    expect(messages.filter((row) => row.role === 'tool' && row.content.includes('"success":true'))).toHaveLength(1);
    expect(messages.filter((row) => row.role === 'assistant' && row.id !== f.assistant.id && row.content.includes('已完成整组修改'))).toHaveLength(1);
  });

  it('S04 rejects a parent move that leaves a child behind', async () => {
    const f = await seed();
    await tasks.create({ topicId: f.topic.id, parentId: f.A.id, title: '未列入的子任务' });
    const before = await snapshot(f.topic.id);
    const approvals = await prisma.approval.count({ where: { conversationId: f.conversation.id } });
    const proposals = await prisma.proposal.count();
    await expect(prepareTaskBatch(input(f))).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    expect(await snapshot(f.topic.id)).toEqual(before);
    expect(await prisma.approval.count({ where: { conversationId: f.conversation.id } })).toBe(approvals);
    expect(await prisma.proposal.count()).toBe(proposals);
  });

  it('S05 rolls back when the third real execution throws', async () => {
    const f = await seed();
    const p = await prepareTaskBatch(input(f));
    const before = await snapshot(f.topic.id);
    const records = new Set((await prisma.changeRecord.findMany({ where: { OR: [{ entityId: { in: [f.A.id, f.B.id, f.topic.id] } }, { proposalId: p.proposalId }] }, select: { id: true } })).map((row) => row.id));
    let real = 0;
    const originals = { create: TaskService.prototype.create, update: TaskService.prototype.update };
    const install = (method: 'create' | 'update') => vi.spyOn(TaskService.prototype, method).mockImplementation((function (this: TaskService, ...args: unknown[]) {
      const context = args[args.length - 1] as { preview?: boolean } | undefined;
      const original = originals[method] as (this: TaskService, ...values: unknown[]) => unknown;
      if (context && typeof context === 'object' && context.preview) return original.apply(this, args);
      real += 1;
      if (real === 3) throw new DomainError('INJECTED_FAILURE', '第3条正式执行失败');
      return original.apply(this, args);
    }) as never);
    const createSpy = install('create');
    const updateSpy = install('update');
    try {
      const response = await new AgentService().approve(p.approvalId);
      expect(response.result).toMatchObject({ success: false, code: 'INJECTED_FAILURE', data: { atomic: true, appliedOperationCount: 0 } });
      expect(await snapshot(f.topic.id)).toEqual(before);
      const after = await prisma.changeRecord.findMany({ where: { OR: [{ entityId: { in: [f.A.id, f.B.id, f.topic.id] } }, { proposalId: p.proposalId }] }, select: { id: true } });
      expect(after.map((row) => row.id).sort()).toEqual([...records].sort());
    } finally {
      createSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  it('S06 keeps a completed task done and creates the parent as todo', async () => {
    const f = await seed();
    await tasks.update(f.B.id, { status: 'done' });
    await tasks.update(f.A.id, { status: 'done' });
    const rows = await snapshot(f.topic.id);
    const A = rows.find((row) => row.id === f.A.id)!;
    const B = rows.find((row) => row.id === f.B.id)!;
    const args = { summary: '完成后再重组', operations: [
      { kind: 'task.create' as const, clientRef: 'parent', input: { title: oldTitle, topicId: f.topic.id } },
      { kind: 'task.update' as const, targetId: A.id, expectedRevision: A.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } },
      { kind: 'task.update' as const, targetId: B.id, expectedRevision: B.revision, input: { parentId: { $ref: 'parent' } } },
    ] };
    const prepared = await prepareTaskBatch(await withCall(f, args));
    const response = await new AgentService().approve(prepared.approvalId);
    expect(response.result.success).toBe(true);
    const after = await prisma.task.findMany({ where: { topicId: f.topic.id } });
    const parent = after.find((row) => row.id !== A.id && row.id !== B.id)!;
    expect(after.find((row) => row.id === A.id)).toMatchObject({ status: 'done', parentId: parent.id });
    expect(parent).toMatchObject({ status: 'todo', parentId: null });
  });

  it('S07 preserves tags and existing activity while adding the batch history', async () => {
    const f = await seed();
    const tagA = await new TagService().create({ name: `batch-a-${randomUUID().slice(0, 8)}` });
    const tagB = await new TagService().create({ name: `batch-b-${randomUUID().slice(0, 8)}` });
    tagIds.add(tagA.id); tagIds.add(tagB.id);
    await tasks.update(f.A.id, { tagIds: [tagA.id] });
    await tasks.update(f.B.id, { tagIds: [tagB.id] });
    const rows = await snapshot(f.topic.id);
    const A = rows.find((row) => row.id === f.A.id)!;
    const B = rows.find((row) => row.id === f.B.id)!;
    const args = { summary: '保留标签', operations: [
      { kind: 'task.create' as const, clientRef: 'parent', input: { title: oldTitle, topicId: f.topic.id } },
      { kind: 'task.update' as const, targetId: A.id, expectedRevision: A.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } },
      { kind: 'task.update' as const, targetId: B.id, expectedRevision: B.revision, input: { parentId: { $ref: 'parent' } } },
    ] };
    const beforeTags = await prisma.taskTag.findMany({ where: { taskId: { in: [A.id, B.id] } }, orderBy: [{ taskId: 'asc' }, { tagId: 'asc' }] });
    const beforeRecords = (await prisma.changeRecord.findMany({ where: { entityId: { in: [A.id, B.id, tagA.id, tagB.id] } }, select: { id: true } })).map((row) => row.id);
    const prepared = await prepareTaskBatch(await withCall(f, args));
    await new AgentService().approve(prepared.approvalId);
    const afterTags = await prisma.taskTag.findMany({ where: { taskId: { in: [A.id, B.id] } }, orderBy: [{ taskId: 'asc' }, { tagId: 'asc' }] });
    expect(afterTags.map((row) => ({ taskId: row.taskId, tagId: row.tagId }))).toEqual(beforeTags.map((row) => ({ taskId: row.taskId, tagId: row.tagId })));
    const afterRecords = await prisma.changeRecord.findMany({ where: { OR: [{ entityId: { in: [A.id, B.id, tagA.id, tagB.id] } }, { proposalId: prepared.proposalId }] }, select: { id: true } });
    for (const id of beforeRecords) expect(afterRecords.map((row) => row.id)).toContain(id);
    expect(afterRecords.length).toBeGreaterThan(beforeRecords.length);
  });

  it('S08 rejects illegal graphs without writing tasks', async () => {
    const cases: Array<{ code: string; operations: unknown[] }> = [
      { code: 'INVALID_PARENT', operations: [] },
      { code: 'INVALID_PARENT', operations: [] },
      { code: 'INVALID_PARENT', operations: [] },
      { code: 'INVALID_REFERENCE', operations: [] },
      { code: 'INVALID_REFERENCE', operations: [] },
      { code: 'INVALID_BATCH', operations: [] },
    ];
    const f = await seed();
    const self = { summary: '自己', operations: [{ kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: f.A.id } }] };
    const cycle = { summary: '循环', operations: [
      { kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: f.B.id } },
      { kind: 'task.update', targetId: f.B.id, expectedRevision: f.B.revision, input: { parentId: f.A.id } },
    ] };
    const deep = { summary: '两层', operations: [
      { kind: 'task.create', clientRef: 'parent', input: { title: oldTitle, topicId: f.topic.id } },
      { kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: { $ref: 'parent' } } },
      { kind: 'task.update', targetId: f.B.id, expectedRevision: f.B.revision, input: { parentId: f.A.id } },
    ] };
    const missing = { summary: '未知引用', operations: [{ kind: 'task.update', targetId: f.B.id, expectedRevision: f.B.revision, input: { parentId: { $ref: 'missing' } } }] };
    const duplicateRef = { summary: '重复引用', operations: [
      { kind: 'task.create', clientRef: 'parent', input: { title: '甲', topicId: f.topic.id } },
      { kind: 'task.create', clientRef: 'parent', input: { title: '乙', topicId: f.topic.id } },
    ] };
    const duplicateTarget = { summary: '重复目标', operations: [
      { kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { title: '一次' } },
      { kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { title: '两次' } },
    ] };
    cases[0].operations = self.operations; cases[1].operations = cycle.operations; cases[2].operations = deep.operations;
    cases[3].operations = missing.operations; cases[4].operations = duplicateRef.operations; cases[5].operations = duplicateTarget.operations;
    const payloads = [self, cycle, deep, missing, duplicateRef, duplicateTarget];
    for (const [index, payload] of payloads.entries()) {
      const before = await snapshot(f.topic.id);
      const approvals = await prisma.approval.count({ where: { conversationId: f.conversation.id } });
      const callId = `bad-${index}-${randomUUID()}`;
      await expect(prepareTaskBatch(await withCall(f, payload, callId))).rejects.toMatchObject({ code: cases[index].code });
      expect(await snapshot(f.topic.id)).toEqual(before);
      expect(await prisma.approval.count({ where: { conversationId: f.conversation.id } })).toBe(approvals);
    }
  });

  it('S09 accepts an internal revision bump and rejects external read-set changes', async () => {
    const f = await seed();
    const sibling = await tasks.create({ topicId: f.topic.id, title: '同级根任务' });
    const parent = await tasks.create({ topicId: f.topic.id, title: '现有父任务' });
    const current = await snapshot(f.topic.id);
    const A = current.find((row) => row.id === f.A.id)!;
    const B = current.find((row) => row.id === f.B.id)!;
    const moveOntoParent = { summary: '挂到现有父任务', operations: [
      { kind: 'task.update', targetId: B.id, expectedRevision: B.revision, input: { parentId: parent.id } },
      { kind: 'task.update', targetId: A.id, expectedRevision: A.revision, input: { title: '执行修改', parentId: parent.id } },
    ] };
    const prepared = await prepareTaskBatch(await withCall(f, moveOntoParent));
    await tasks.update(parent.id, { description: '父级被外部改动' });
    const parentBefore = await snapshot(f.topic.id);
    const parentResponse = await new AgentService().approve(prepared.approvalId);
    expect(parentResponse.result).toMatchObject({ success: false, code: 'VERSION_CONFLICT' });
    expect(await snapshot(f.topic.id)).toEqual(parentBefore);

    const fresh = await snapshot(f.topic.id);
    const nextA = fresh.find((row) => row.id === f.A.id)!;
    const nextB = fresh.find((row) => row.id === f.B.id)!;
    const standard = { summary: '整组调整', operations: [
      { kind: 'task.create' as const, clientRef: 'parent', input: { title: oldTitle, topicId: f.topic.id } },
      { kind: 'task.update' as const, targetId: nextA.id, expectedRevision: nextA.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } },
      { kind: 'task.update' as const, targetId: nextB.id, expectedRevision: nextB.revision, input: { parentId: { $ref: 'parent' } } },
    ] };
    const siblingCall = `sib-${randomUUID()}`;
    const siblingPrepared = await prepareTaskBatch(await withCall(f, standard, siblingCall));
    await tasks.update(sibling.id, { description: '兄弟被外部改动' });
    const siblingBefore = await snapshot(f.topic.id);
    expect((await new AgentService().approve(siblingPrepared.approvalId)).result).toMatchObject({ success: false, code: 'VERSION_CONFLICT' });
    expect(await snapshot(f.topic.id)).toEqual(siblingBefore);

    const again = await snapshot(f.topic.id);
    const okArgs = { summary: '内部版本上升仍成功', operations: [
      { kind: 'task.create' as const, clientRef: 'parent', input: { title: oldTitle, topicId: f.topic.id } },
      { kind: 'task.update' as const, targetId: f.A.id, expectedRevision: again.find((row) => row.id === f.A.id)!.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } },
      { kind: 'task.update' as const, targetId: f.B.id, expectedRevision: again.find((row) => row.id === f.B.id)!.revision, input: { parentId: { $ref: 'parent' } } },
    ] };
    const ok = await prepareTaskBatch(await withCall(f, okArgs, `ok-${randomUUID()}`));
    const done = await new AgentService().approve(ok.approvalId);
    expect(done.result.success).toBe(true);
    const finalRows = await prisma.task.findMany({ where: { topicId: f.topic.id } });
    expect(finalRows.find((row) => row.id === f.A.id)!.revision).not.toBe(f.A.revision);
    expect(finalRows.find((row) => row.id === f.A.id)).toMatchObject({ title: '执行修改' });
  });

  it('S10 reads old proposal, old bare result, and the new envelope', () => {
    expect(readStoredApproval(JSON.stringify({ proposalId: 'p', proposalRevision: 1, toolCallId: 'c' }))).toMatchObject({ resultState: 'proposal', legacyProposal: { proposalId: 'p' } });
    expect(readStoredApproval({ success: true, data: { title: '已改' } })).toMatchObject({ resultState: 'result', legacyResult: { success: true } });
    expect(readStoredApproval({ schemaVersion: 1, kind: 'task_batch', proposalId: 'p', toolCallId: 'c', preview: { schemaVersion: 1, summary: '整组', operationCount: 1, beforeTasks: [], afterTasks: [], changes: [] } })).toMatchObject({ resultState: 'batch', proposalId: 'p' });
    expect(readStoredApproval('{oops')).toMatchObject({ resultState: 'unreadable' });
  });

  it('S11 feeds an illegal update back to the model and then creates one approval', async () => {
    const f = await seed();
    const seen: ModelMessage[][] = [];
    const model = scripted((messages) => {
      seen.push(messages);
      if (seen.length === 1) return { toolCalls: [propose('bad-parent', { summary: '非法', operations: [{ kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: f.A.id } }] })] };
      return { toolCalls: [propose('good-batch', f.args)] };
    });
    const result = await new AgentService(model).chat({ conversationId: f.conversation.id, message: '请整组调整', pageContext: { topicId: f.topic.id, page: 'board' } });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(String(seen[1].find((message) => message.role === 'tool')?.content))).toMatchObject({ code: 'INVALID_PARENT' });
    expect(result.events.filter((event) => event.type === 'approval_required')).toHaveLength(1);
    expect(await prisma.approval.count({ where: { conversationId: f.conversation.id, status: 'pending', toolName: 'propose_changes' } })).toBe(1);
  });

  it('S12 stops the third identical failure without another model round', async () => {
    const f = await seed();
    let streams = 0;
    const args = { summary: '重复失败', operations: [{ kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: f.A.id } }] };
    const model = scripted(() => {
      streams += 1;
      return { toolCalls: [1, 2, 3].map((index) => propose(`same-${index}`, args)) };
    });
    const result = await new AgentService(model).chat({ conversationId: f.conversation.id, message: '重复失败的整组', pageContext: { topicId: f.topic.id } });
    expect(streams).toBe(1);
    const results = result.events.filter((event) => event.type === 'tool_result' && event.toolName !== 'load_tools');
    expect(results).toHaveLength(3);
    expect(results[0]?.result?.code).toBe('INVALID_PARENT');
    expect(results.slice(1).map((event) => event.result?.code)).toEqual(['INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS']);
    expect(result.events.some((event) => event.type === 'error')).toBe(false);
    const tools = await prisma.message.findMany({ where: { conversationId: f.conversation.id, role: 'tool', toolCallId: { in: ['same-1', 'same-2', 'same-3'] } } });
    expect(tools).toHaveLength(3);
  });

  it('S13 pairs the same call id to the assistant that produced it', () => {
    const row = (id: string, role: 'assistant' | 'tool', content: string, extra: { toolCalls?: string; toolCallId?: string }) => ({ id, role, content, status: 'completed' as const, toolCalls: extra.toolCalls ?? null, toolCallId: extra.toolCallId ?? null, compactedAt: null });
    const callPayload = JSON.stringify([{ id: 'same', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }]);
    const replayed = replayMessages([
      row('a1', 'assistant', '第一次', { toolCalls: callPayload }),
      row('t1', 'tool', JSON.stringify({ assistantMessageId: 'a1', success: true, data: 'first-result' }), { toolCallId: 'same' }),
      row('a2', 'assistant', '第二次', { toolCalls: callPayload }),
      row('t2', 'tool', JSON.stringify({ assistantMessageId: 'a2', success: true, data: 'second-result' }), { toolCallId: 'same' }),
    ]);
    const tools = replayed.filter((message) => message.role === 'tool');
    expect(tools.map((message) => message.content)).toEqual([
      expect.stringContaining('first-result'),
      expect.stringContaining('second-result'),
    ]);
  });

  it('S14 replays a lost approval response without bumping revisions', async () => {
    const f = await seed();
    const p = await prepareTaskBatch(input(f));
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: p.proposalId } });
    const first = await owner('post', `/api/agent/approvals/${p.approvalId}/approve`);
    expect(first.status).toBe(200);
    const revisions = await snapshot(f.topic.id);
    const second = await owner('post', `/api/agent/approvals/${p.approvalId}/approve`);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(await snapshot(f.topic.id)).toEqual(revisions);
    expect(proposal.id).toBe(p.proposalId);
  });

  it('S15 replaces one pending batch and leaves the old one unable to edit tasks', async () => {
    const f = await seed();
    const first = await prepareTaskBatch(input(f));
    const before = await snapshot(f.topic.id);
    const user = await conversations.addMessage(f.conversation.id, 'user', '换成新的整组');
    const assistant = await conversations.addMessage(f.conversation.id, 'assistant', '替换整组');
    const callId = `replace-${randomUUID()}`;
    const args = { ...f.args, supersedesApprovalId: first.approvalId };
    await conversations.updateMessage(assistant.id, { toolCalls: JSON.stringify([{ id: callId, type: 'function', function: { name: 'propose_task_changes', arguments: JSON.stringify(args) } }]) });
    const next = await prepareTaskBatch({ conversationId: f.conversation.id, assistantMessageId: assistant.id, sourceUserMessageId: user.id, toolCallId: callId, arguments: args });
    expect(await snapshot(f.topic.id)).toEqual(before);
    const old = await prisma.approval.findUniqueOrThrow({ where: { id: first.approvalId } });
    expect(readStoredApproval(old.result).outcome).toMatchObject({ success: false, code: 'APPROVAL_SUPERSEDED' });
    const replay = await new AgentService().approve(first.approvalId);
    expect(replay.result).toMatchObject({ success: false, code: 'APPROVAL_SUPERSEDED' });
    expect(await snapshot(f.topic.id)).toEqual(before);
    const pending = await prisma.approval.findMany({ where: { conversationId: f.conversation.id, status: 'pending', toolName: 'propose_task_changes' } });
    expect(pending.map((row) => row.id)).toEqual([next.approvalId]);
  });

  it('S16 keeps the old pending approval when the replacement preview fails', async () => {
    const f = await seed();
    const first = await prepareTaskBatch(input(f));
    const user = await conversations.addMessage(f.conversation.id, 'user', '这个替换是错的');
    const assistant = await conversations.addMessage(f.conversation.id, 'assistant', '尝试替换');
    const callId = `bad-replace-${randomUUID()}`;
    const args = { summary: '错误替换', supersedesApprovalId: first.approvalId, operations: [{ kind: 'task.update' as const, targetId: f.A.id, expectedRevision: f.A.revision, input: { parentId: f.A.id } }] };
    await conversations.updateMessage(assistant.id, { toolCalls: JSON.stringify([{ id: callId, type: 'function', function: { name: 'propose_task_changes', arguments: JSON.stringify(args) } }]) });
    const proposals = await prisma.proposal.count();
    await expect(prepareTaskBatch({ conversationId: f.conversation.id, assistantMessageId: assistant.id, sourceUserMessageId: user.id, toolCallId: callId, arguments: args })).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    expect(await prisma.proposal.count()).toBe(proposals);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: first.approvalId } })).status).toBe('pending');
    const applied = await new AgentService().approve(first.approvalId);
    expect(applied.result.success).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.A.id } })).title).toBe('执行修改');
  });

  it('S17 approving from the proposal endpoint closes the chat approval the same way', async () => {
    const f = await seed();
    const chatSeed = await seed();
    const prepared = await prepareTaskBatch(input(f));
    const chat = await prepareTaskBatch(input(chatSeed));
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: prepared.proposalId } });
    const http = await owner('post', `/api/v1/proposals/${prepared.proposalId}/approve`, { expectedRevision: proposal.revision, requestId: randomUUID() });
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    const viaChat = await new AgentService().approve(chat.approvalId);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: prepared.approvalId } })).status).toBe('executed');
    const httpMessages = await prisma.message.findMany({ where: { conversationId: f.conversation.id }, orderBy: { createdAt: 'asc' } });
    const chatMessages = await prisma.message.findMany({ where: { conversationId: chatSeed.conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(httpMessages.filter((row) => row.role === 'tool').map((row) => JSON.parse(row.content).success)).toEqual([true]);
    expect(chatMessages.filter((row) => row.role === 'tool').map((row) => JSON.parse(row.content).success)).toEqual([true]);
    expect(httpMessages.some((row) => row.role === 'assistant' && row.content.includes('已完成整组修改'))).toBe(true);
    expect(viaChat.assistantMessage).toContain('已完成整组修改');
    expect(chatMessages.some((row) => row.content === viaChat.assistantMessage)).toBe(true);
  });

  it('S18 rejecting from the proposal endpoint blocks a later chat execution', async () => {
    const f = await seed();
    const prepared = await prepareTaskBatch(input(f));
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: prepared.proposalId } });
    const http = await owner('post', `/api/v1/proposals/${prepared.proposalId}/reject`, { expectedRevision: proposal.revision });
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: prepared.approvalId } })).status).toBe('rejected');
    const again = await new AgentService().approve(prepared.approvalId);
    expect(again.result).toMatchObject({ success: false, code: 'USER_REJECTED' });
    expect(await snapshot(f.topic.id)).toEqual(f.rows);
  });

  it('S19 a status question leaves the pending batch and tasks untouched', async () => {
    const f = await seed();
    const prepared = await prepareTaskBatch(input(f));
    const before = await snapshot(f.topic.id);
    let prompt = '';
    const model = scripted((messages) => { prompt = String(messages[0]?.content ?? ''); return { text: '还在等待确认。' }; });
    await new AgentService(model).chat({ conversationId: f.conversation.id, message: '看看现在状态', pageContext: { topicId: f.topic.id } });
    expect(prompt).toContain(`approvalId=${prepared.approvalId}`);
    expect(prompt).toContain('propose_changes');
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: prepared.approvalId } })).status).toBe('pending');
    expect(await snapshot(f.topic.id)).toEqual(before);
  });

  it('S20 rejects status, dueDate, and entityId instead of ignoring them', async () => {
    const f = await seed();
    const status = { summary: '带状态', operations: [{ kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { title: '执行修改', status: 'done' } }] };
    const due = { summary: '带日期', operations: [{ kind: 'task.update', targetId: f.A.id, expectedRevision: f.A.revision, input: { dueDate: '2026-10-13' } }] };
    const entity = { summary: '指定编号', operations: [{ kind: 'task.create', clientRef: 'parent', entityId: 'fixed-id', input: { title: oldTitle, topicId: f.topic.id } }] };
    for (const args of [status, due, entity]) {
      const before = await snapshot(f.topic.id);
      await expect(prepareTaskBatch(await withCall(f, args, `strict-${randomUUID()}`))).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
      expect(await snapshot(f.topic.id)).toEqual(before);
    }
  });

  it('S21 keeps authentication and owner checks on the batch endpoints', async () => {
    const f = await seed();
    const prepared = await prepareTaskBatch(input(f));
    expect((await request(app).post(`/api/agent/approvals/${prepared.approvalId}/approve`)).status).toBe(401);
    const session = await ownerSession(app);
    expect((await request(app).post(`/api/agent/approvals/${prepared.approvalId}/approve`).set('Cookie', session.cookie)).status).toBe(403);
    const created = await owner('post', '/api/v1/connections', { name: '批量连接', host: 'codex', topicIds: [], includeInbox: true, autoActions: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    connectionIds.add(created.body.data.id);
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: prepared.proposalId } });
    const denied = await request(app).post(`/api/v1/proposals/${prepared.proposalId}/approve`).set('Authorization', `Bearer ${created.body.data.token}`).send({ expectedRevision: proposal.revision, requestId: randomUUID() });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: prepared.approvalId } })).status).toBe('pending');
  });

  it('S22 returns the committed parent revision and child links', async () => {
    const f = await seed();
    const prepared = await prepareTaskBatch(input(f));
    const response = await new AgentService().approve(prepared.approvalId);
    expect(response.result.success).toBe(true);
    const data = response.result.data as BatchSuccess['data'];
    const fresh = await prisma.task.findMany({ where: { topicId: f.topic.id } });
    for (const task of data.tasks) {
      const row = fresh.find((item) => item.id === task.id);
      expect(row).toMatchObject({ revision: task.revision, parentId: task.parentId, title: task.title });
    }
    const parent = fresh.find((row) => row.id !== f.A.id && row.id !== f.B.id)!;
    const submittedParent = data.tasks.find((task) => task.id === parent.id)!;
    expect(submittedParent.revision).toBe(parent.revision);
    expect(data.tasks.find((task) => task.id === f.A.id)).toMatchObject({ parentId: parent.id, title: '执行修改' });
    expect(data.tasks.find((task) => task.id === f.B.id)).toMatchObject({ parentId: parent.id, title: checkTitle });
  });
});
