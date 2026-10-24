import { withTestToolLoading } from './agent/test-model-tools.js';
import { testDiscovery, withoutDiscovery } from './agent/test-model-tools.js';
import type { ModelToolDefinition } from './agent.js';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import request, { ownerSession } from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';

const api = request(app);

type ReviewEvent = {
  approvalId: string;
  proposalId?: string;
  proposalRevision?: number;
  previewHash?: string;
  runId?: string;
  review?: { affectedEntityCount: number; relatedEntityCount: number; consequences: string[]; entities: Array<{ origin: string; entityId: string; entityType: string }> };
};
type Decision = { outcome?: { status: string; changeId: string | null; appliedOperationCount: number; code?: string }; resumed?: boolean };

function latestUser(messages: ModelMessage[]) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function agentFor(script: (messages: ModelMessage[]) => { text?: string; toolCalls?: ToolCall[] } | never) {
  return new AgentService({
    stream: async function* (messages: ModelMessage[], _signal?: AbortSignal, _includeTools?: boolean, tools?: ModelToolDefinition[]) {
      const discovery = testDiscovery(tools);
      if (discovery) { yield discovery; return; }
      messages = withoutDiscovery(messages);
      const delta = script(messages);
      if (delta.text) yield { text: delta.text };
      if (delta.toolCalls?.length) yield { toolCalls: delta.toolCalls };
    },
  } as never);
}

function proposeScript(phrase: string, operations: unknown[], summary: string) {
  return (messages: ModelMessage[]) => {
    const text = latestUser(messages);
    if (messages.some((message) => message.role === 'tool')) {
      if (text.includes('续办失败')) throw Object.assign(new Error('模型服务错误：503'), { code: 'MODEL_HTTP_ERROR' });
      return { text: '剩余工作已完成。' };
    }
    if (!text.includes(phrase)) return { text: '好的。' };
    return { text: '我准备修改。', toolCalls: [{ id: `call-${phrase}`, name: 'propose_changes', arguments: { summary, operations } }] };
  };
}

async function businessRows() {
  const [tasks, materials, memories] = await Promise.all([
    prisma.task.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, description: true, status: true, priority: true, dueDate: true, scheduledStart: true, scheduledEnd: true, estimatedMinutes: true, topicId: true, parentId: true, revision: true, deletedAt: true, resultSummary: true } }),
    prisma.material.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, revision: true, archivedAt: true } }),
    prisma.memory.findMany({ orderBy: { id: 'asc' }, select: { id: true, title: true, content: true, revision: true, status: true } }),
  ]);
  return { tasks, materials, memories };
}

async function task(input: Record<string, unknown>) {
  const response = await api.post('/api/tasks').send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number; title: string; topicId: string | null };
}

async function freshTask(id: string) {
  const response = await api.get(`/api/tasks/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number; title: string; topicId: string | null; parentId: string | null; status: string; dueDate: string | null; scheduledStart: string | null; scheduledEnd: string | null; estimatedMinutes: number | null; priority: string };
}

function approvalFrom(events: Array<{ type: string }>) {
  const event = events.find((item) => item.type === 'approval_required') as ReviewEvent | undefined;
  expect(event?.approvalId, JSON.stringify(events)).toBeTruthy();
  return event!;
}

async function decide(agent: AgentService, event: ReviewEvent, action: 'approve' | 'reject' = 'approve') {
  const method = action === 'approve' ? agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash }) : agent.reject(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash });
  return method as Promise<Decision>;
}

async function waitFor(read: () => Promise<string | null | undefined>) {
  const started = Date.now();
  let latest = '';
  while (Date.now() - started < 5000) {
    latest = (await read()) ?? '';
    if (latest.includes('后续回答未完成')) return latest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return latest;
}

async function waitForRow<T>(read: () => Promise<T | null>) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const row = await read();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('streaming follow-up did not start');
}

describe('server owned change review', () => {
  it('previews without writing, then applies one idempotent receipt', async () => {
    const stamp = Date.now();
    const tag = await api.post('/api/tags').send({ name: `评审标签-${stamp}` });
    expect(tag.status, JSON.stringify(tag.body)).toBe(200);
    const dated = await task({ title: `日期样本-${stamp}`, dueDate: '2026-10-15', scheduledStart: '2026-10-15T23:00', scheduledEnd: '2026-10-16T01:00' });
    const flagged = await task({ title: `状态样本-${stamp}` });
    const estimated = await task({ title: `用时样本-${stamp}`, dueDate: '2026-10-15', scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' });
    const beforePrepare = await businessRows();
    const agent = agentFor(proposeScript(`调整这三项-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: dated.id, expectedRevision: dated.revision, input: { dueDate: '2026-10-16' } } },
      { family: 'workspace', command: { kind: 'task.update', targetId: flagged.id, expectedRevision: flagged.revision, input: { status: 'doing', priority: 'high', tagIds: [tag.body.data.id] } } },
      { family: 'workspace', command: { kind: 'task.update', targetId: estimated.id, expectedRevision: estimated.revision, input: { estimatedMinutes: 90 } } },
    ], '调整日期、状态和用时'));
    const chat = await agent.chat({ message: `调整这三项-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-fields-${stamp}` });
    const afterPrepare = await businessRows();
    expect(afterPrepare.tasks).toEqual(beforePrepare.tasks);
    expect(afterPrepare.materials).toEqual(beforePrepare.materials);
    expect(afterPrepare.memories).toEqual(beforePrepare.memories);
    const pending = chat.events.filter((event) => event.type === 'approval_required');
    expect(pending).toHaveLength(1);
    const review = approvalFrom(chat.events).review!;
    expect(review.affectedEntityCount).toBe(3);
    expect(review.relatedEntityCount).toBe(0);
    expect(review.consequences.join('\n')).toContain('2026-10-16');
    const firstApprove = await decide(agent, approvalFrom(chat.events));
    const secondApprove = await decide(agent, approvalFrom(chat.events));
    expect(firstApprove.outcome?.status).toBe('executed');
    expect(secondApprove.outcome).toEqual(firstApprove.outcome);
    expect(secondApprove.outcome?.changeId).toBe(firstApprove.outcome?.changeId);
    const completionMessagesForApproval = await prisma.message.findMany({ where: { conversationId: chat.conversationId, content: { contains: firstApprove.outcome!.changeId! } } });
    expect(completionMessagesForApproval).toHaveLength(1);
    expect(await freshTask(dated.id)).toMatchObject({ dueDate: '2026-10-16', scheduledStart: '2026-10-16T23:00', scheduledEnd: '2026-10-17T01:00' });
    expect(await freshTask(flagged.id)).toMatchObject({ status: 'doing', priority: 'high' });
    expect(await freshTask(estimated.id)).toMatchObject({ estimatedMinutes: 90, scheduledStart: '2026-10-15T11:00', scheduledEnd: '2026-10-15T12:00' });
  });

  it('reparents old tasks under a new parent in one approval', async () => {
    const stamp = Date.now();
    const topic = await api.post('/api/topics').send({ name: `重组-${stamp}` });
    const parent = await task({ topicId: topic.body.data.id, title: `原父任务-${stamp}` });
    const child = await task({ topicId: topic.body.data.id, parentId: parent.id, title: `原子任务-${stamp}` });
    const currentParent = await freshTask(parent.id);
    const currentChild = await freshTask(child.id);
    const agent = agentFor(proposeScript(`原子重组-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.create', clientRef: 'parent', input: { title: currentParent.title, topicId: topic.body.data.id } } },
      { family: 'workspace', command: { kind: 'task.update', targetId: currentParent.id, expectedRevision: currentParent.revision, input: { title: '执行修改', parentId: { $ref: 'parent' } } } },
      { family: 'workspace', command: { kind: 'task.update', targetId: currentChild.id, expectedRevision: currentChild.revision, input: { parentId: { $ref: 'parent' } } } },
    ], '原子重组'));
    const before = await businessRows();
    const chat = await agent.chat({ message: `原子重组-${stamp}`, pageContext: { page: 'board', topicId: topic.body.data.id }, requestKey: `review-tree-${stamp}` });
    expect(await businessRows()).toEqual(before);
    const approved = await decide(agent, approvalFrom(chat.events));
    expect(approved.outcome?.status).toBe('executed');
    const renamed = await freshTask(parent.id);
    const moved = await freshTask(child.id);
    expect(renamed.title).toBe('执行修改');
    expect(renamed.parentId).toBeTruthy();
    expect(moved.parentId).toBe(renamed.parentId);
    expect(moved.parentId).not.toBe(parent.id);
  });

  it('shows child completion as a related change and applies it only after approval', async () => {
    const stamp = Date.now();
    const parent = await task({ title: `完成父任务-${stamp}` });
    const child = await task({ title: `会被带动的子任务-${stamp}`, parentId: parent.id });
    const current = await freshTask(parent.id);
    const agent = agentFor(proposeScript(`完成父子-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: current.id, expectedRevision: current.revision, input: { status: 'done', completeChildren: true } } },
    ], '完成父任务和子任务'));
    const before = await businessRows();
    const chat = await agent.chat({ message: `完成父子-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-cascade-${stamp}` });
    expect((await freshTask(child.id)).status).toBe('todo');
    expect(await businessRows()).toEqual(before);
    const review = approvalFrom(chat.events).review!;
    expect(review.relatedEntityCount).toBeGreaterThanOrEqual(1);
    expect(review.affectedEntityCount).toBe(review.entities.length);
    const approved = await decide(agent, approvalFrom(chat.events));
    expect(approved.outcome?.status).toBe('executed');
    expect((await freshTask(parent.id)).status).toBe('done');
    expect((await freshTask(child.id)).status).toBe('done');
  });

  it('archives a list without detaching tasks, and moving to inbox does detach them', async () => {
    const stamp = Date.now();
    const archived = await api.post('/api/topics').send({ name: `归档样本-${stamp}` });
    const moved = await api.post('/api/topics').send({ name: `移出样本-${stamp}` });
    const stays = await task({ topicId: archived.body.data.id, title: `留在归档清单-${stamp}` });
    const leaves = await task({ topicId: moved.body.data.id, title: `进入收集箱-${stamp}` });
    const archivedTopic = await api.get(`/api/topics/${archived.body.data.id}`);
    const movedTopic = await api.get(`/api/topics/${moved.body.data.id}`);
    const archiveAgent = agentFor(proposeScript(`归档清单-${stamp}`, [
      { family: 'workspace', command: { kind: 'topic.archive', targetId: archived.body.data.id, expectedRevision: archivedTopic.body.data.revision, input: {} } },
    ], '归档清单'));
    const archiveChat = await archiveAgent.chat({ message: `归档清单-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-archive-${stamp}` });
    expect((await decide(archiveAgent, approvalFrom(archiveChat.events))).outcome?.status).toBe('executed');
    expect((await freshTask(stays.id)).topicId).toBe(archived.body.data.id);
    expect((await prisma.topic.findUniqueOrThrow({ where: { id: archived.body.data.id } })).archivedAt).toBeTruthy();
    const moveAgent = agentFor(proposeScript(`移入收集箱-${stamp}`, [
      { family: 'workspace', command: { kind: 'topic.move_tasks_to_inbox', targetId: moved.body.data.id, expectedRevision: movedTopic.body.data.revision, input: {} } },
    ], '移入收集箱'));
    const moveChat = await moveAgent.chat({ message: `移入收集箱-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-inbox-${stamp}` });
    expect((await decide(moveAgent, approvalFrom(moveChat.events))).outcome?.status).toBe('executed');
    expect((await freshTask(leaves.id)).topicId).toBeNull();
  });

  it('keeps a task, material, and memory in one transaction and rolls all of them back on conflict', async () => {
    const stamp = Date.now();
    const item = await task({ title: `同事务任务-${stamp}` });
    const material = await api.post('/api/v1/commands').send({ requestId: `material-${stamp}`, commands: [{ kind: 'material.create', input: { topicId: null, kind: 'text', title: `原资料-${stamp}`, content: '资料正文' } }] });
    expect(material.status, JSON.stringify(material.body)).toBe(200);
    const created = material.body.data.results[0] as { id: string; revision: number };
    const beforePrepare = await businessRows();
    const agent = agentFor(proposeScript(`同一事务-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `已改任务-${stamp}` } } },
      { family: 'library', args: { action: 'update', materialId: created.id, revision: created.revision, title: `已改资料-${stamp}` } },
      { family: 'memory', args: { action: 'add', target: 'inbox', title: `同事务记忆-${stamp}`, content: '来自同一次确认' } },
    ], '同时改任务、资料和记忆'));
    const chat = await agent.chat({ message: `同一事务-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-atomic-${stamp}` });
    const afterPrepare = await businessRows();
    expect(afterPrepare.tasks).toEqual(beforePrepare.tasks);
    expect(afterPrepare.materials).toEqual(beforePrepare.materials);
    expect(afterPrepare.memories).toEqual(beforePrepare.memories);
    const applied = await decide(agent, approvalFrom(chat.events));
    expect(applied.outcome?.status).toBe('executed');
    expect((await freshTask(item.id)).title).toBe(`已改任务-${stamp}`);
    expect((await prisma.material.findUniqueOrThrow({ where: { id: created.id } })).title).toBe(`已改资料-${stamp}`);
    expect(await prisma.memory.findFirst({ where: { title: `同事务记忆-${stamp}` } })).toBeTruthy();

    const current = await freshTask(item.id);
    const materialRow = await prisma.material.findUniqueOrThrow({ where: { id: created.id } });
    const conflictAgent = agentFor(proposeScript(`冲突事务-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: current.id, expectedRevision: current.revision, input: { title: `冲突不该写入-${stamp}` } } },
      { family: 'library', args: { action: 'update', materialId: materialRow.id, revision: materialRow.revision, title: `冲突资料-${stamp}` } },
      { family: 'memory', args: { action: 'add', target: 'inbox', title: `冲突记忆-${stamp}`, content: '不该出现' } },
    ], '这组会冲突'));
    const conflictChat = await conflictAgent.chat({ message: `冲突事务-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-conflict-${stamp}` });
    const changed = await api.patch(`/api/tasks/${current.id}`).send({ description: '审批前被改过' });
    expect(changed.ok, `${changed.status} ${changed.headers['content-type'] ?? ''} ${changed.text}`).toBe(true);
    const allBusinessRowsBeforeApprove = await businessRows();
    const conflict = await decide(conflictAgent, approvalFrom(conflictChat.events));
    expect(conflict.outcome).toMatchObject({ status: 'failed', appliedOperationCount: 0, code: 'VERSION_CONFLICT' });
    expect(await businessRows()).toEqual(allBusinessRowsBeforeApprove);
    expect(await prisma.memory.findFirst({ where: { title: `冲突记忆-${stamp}` } })).toBeNull();
  });

  it('rejects a proposal without writing', async () => {
    const stamp = Date.now();
    const item = await task({ title: `拒绝样本-${stamp}` });
    const agent = agentFor(proposeScript(`拒绝这次-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `不该拒绝后出现-${stamp}` } } },
    ], '拒绝这次修改'));
    const before = await businessRows();
    const chat = await agent.chat({ message: `拒绝这次-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-reject-${stamp}` });
    const rejected = await decide(agent, approvalFrom(chat.events), 'reject');
    expect(rejected.outcome?.appliedOperationCount).toBe(0);
    expect(rejected.outcome?.status).toBe('rejected');
    expect(await businessRows()).toEqual(before);
  });

  it('rejects an undo when current rows changed and keeps both the original receipt and the data', async () => {
    const stamp = Date.now();
    const item = await task({ title: `撤销样本-${stamp}` });
    const agent = agentFor(proposeScript(`准备撤销-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `已执行可撤销-${stamp}` } } },
    ], '先执行再准备撤销'));
    const chat = await agent.chat({ message: `准备撤销-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-undo-${stamp}` });
    const applied = await decide(agent, approvalFrom(chat.events));
    expect(applied.outcome?.status).toBe('executed');
    const undo = await agent.prepareUndo(approvalFrom(chat.events).approvalId) as { approvalId: string };
    const view = await agent.getApproval(undo.approvalId) as { approval: { envelope: { proposalRevision: number; review: { previewHash: string } } } };
    await api.patch(`/api/tasks/${item.id}`).send({ title: `撤销前又改-${stamp}` });
    const rowsBeforeUndoAttempt = await businessRows();
    const undoConflict = await agent.approve(undo.approvalId, { expectedProposalRevision: view.approval.envelope.proposalRevision, previewHash: view.approval.envelope.review.previewHash }) as Decision;
    expect(undoConflict.outcome?.appliedOperationCount).toBe(0);
    expect(await businessRows()).toEqual(rowsBeforeUndoAttempt);
    expect(applied.outcome?.changeId).toBeTruthy();
    expect(await prisma.changeRecord.findUnique({ where: { id: applied.outcome!.changeId! } })).toBeTruthy();
  });

  it('returns one receipt for repeated and concurrent approvals', async () => {
    const stamp = Date.now();
    const item = await task({ title: `并发样本-${stamp}` });
    const agent = agentFor(proposeScript(`并发确认-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `并发之后-${stamp}` } } },
    ], '并发确认'));
    const chat = await agent.chat({ message: `并发确认-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-race-${stamp}` });
    const event = approvalFrom(chat.events);
    const [first, second] = await Promise.all([decide(agent, event), decide(agent, event)]);
    const third = await decide(agent, event);
    const changeId = first.outcome?.changeId ?? second.outcome?.changeId ?? third.outcome?.changeId;
    expect(changeId).toBeTruthy();
    expect(third.outcome?.changeId).toBe(changeId);
    for (const result of [first, second, third]) if (result.outcome) expect(result.outcome.changeId ?? changeId).toBe(changeId);
    expect(await prisma.message.count({ where: { conversationId: chat.conversationId, content: { contains: changeId! } } })).toBe(1);
    expect((await freshTask(item.id)).title).toBe(`并发之后-${stamp}`);
  });

  it('lets only one of approve or reject win', async () => {
    const stamp = Date.now();
    const item = await task({ title: `竞争样本-${stamp}` });
    const agent = agentFor(proposeScript(`竞争确认-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `竞争成功-${stamp}` } } },
    ], '竞争确认'));
    const chat = await agent.chat({ message: `竞争确认-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-xor-${stamp}` });
    const event = approvalFrom(chat.events);
    const results = await Promise.allSettled([decide(agent, event, 'approve'), decide(agent, event, 'reject')]);
    const executed = results.filter((result) => result.status === 'fulfilled' && result.value.outcome?.status === 'executed');
    const rejected = results.filter((result) => result.status === 'fulfilled' && result.value.outcome?.status === 'rejected');
    expect(executed.length + rejected.length).toBe(1);
    const stored = await freshTask(item.id);
    expect(stored.title).toBe(executed.length ? `竞争成功-${stamp}` : item.title);
    const replay = await Promise.allSettled([decide(agent, event, 'approve'), decide(agent, event, 'reject')]);
    expect(replay.filter((result) => result.status === 'fulfilled' && result.value.outcome?.status === 'executed').length).toBe(executed.length);
    expect((await freshTask(item.id)).title).toBe(stored.title);
  });

  it('refuses a missing preview hash and the old proposal route', async () => {
    const stamp = Date.now();
    const item = await task({ title: `缺哈希-${stamp}` });
    const agent = agentFor(proposeScript(`缺哈希-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `不该缺哈希写入-${stamp}` } } },
    ], '需要哈希'));
    const chat = await agent.chat({ message: `缺哈希-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-hash-${stamp}` });
    const event = approvalFrom(chat.events);
    const session = await ownerSession(app);
    const missing = await supertest(app).post(`/api/agent/approvals/${event.approvalId}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({});
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('REVIEW_REQUIRED');
    const legacy = await supertest(app).post(`/api/v1/proposals/${event.proposalId}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ expectedRevision: event.proposalRevision, requestId: `legacy-${stamp}` });
    expect(legacy.status).toBe(409);
    expect(legacy.body.code).toBe('REVIEW_REQUIRED');
    expect((await freshTask(item.id)).title).toBe(item.title);
    const fromChat = await decide(agent, event);
    expect(fromChat.outcome?.status).toBe('executed');
    const other = await task({ title: `待确认页同一服务-${stamp}` });
    const pageAgent = agentFor(proposeScript(`待确认页-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: other.id, expectedRevision: other.revision, input: { title: `页面也走同一服务-${stamp}` } } },
    ], '待确认页'));
    const pageChat = await pageAgent.chat({ message: `待确认页-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-page-${stamp}` });
    const pageEvent = approvalFrom(pageChat.events);
    const fromPage = await supertest(app).post(`/api/agent/approvals/${pageEvent.approvalId}/approve`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ expectedProposalRevision: pageEvent.proposalRevision, previewHash: pageEvent.previewHash });
    expect(fromPage.status, JSON.stringify(fromPage.body)).toBe(200);
    expect(fromPage.body.data.outcome.status).toBe('executed');
    expect(fromPage.body.data.outcome.changeId).toBeTruthy();
    expect((await freshTask(other.id)).title).toBe(`页面也走同一服务-${stamp}`);
  });

  it('keeps the business result when the continuation model fails', async () => {
    const stamp = Date.now();
    const item = await task({ title: `续办前-${stamp}` });
    const agent = agentFor(proposeScript(`续办失败-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `续办后仍在-${stamp}` } } },
    ], '批准后模型会失败'));
    const chat = await agent.chat({ message: `续办失败-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-continue-${stamp}` });
    const approved = await decide(agent, approvalFrom(chat.events));
    expect(approved.outcome?.status).toBe('executed');
    const message = await waitFor(async () => (await prisma.agentRun.findFirst({ where: { conversationId: chat.conversationId }, orderBy: { createdAt: 'desc' } }))?.errorMessage);
    expect(message).toContain('后续回答未完成');
    expect((await freshTask(item.id)).title).toBe(`续办后仍在-${stamp}`);
  });

  it('does not resume or absorb a newer user message into the paused request', async () => {
    const stamp = Date.now();
    const item = await task({ title: `旧请求-${stamp}` });
    const agent = agentFor(proposeScript(`旧请求修改-${stamp}`, [
      { family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `旧请求已改-${stamp}` } } },
    ], '旧请求'));
    const first = await agent.chat({ message: `旧请求修改-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-old-${stamp}` });
    const event = approvalFrom(first.events);
    await agent.chat({ conversationId: first.conversationId, message: `新的消息请停-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-new-${stamp}` });
    const approved = await decide(agent, event);
    expect(approved.resumed).toBe(false);
    expect((await freshTask(item.id)).title).toBe(`旧请求已改-${stamp}`);
    const stored = await prisma.agentRun.findUniqueOrThrow({ where: { id: event.runId } });
    expect(stored.modelMessagesJson).not.toContain(`新的消息请停-${stamp}`);
    expect(stored.state).not.toBe('running');
  });

  it('closes the streaming follow-up when a newer message arrives', async () => {
    const stamp = Date.now();
    const item = await task({ title: `续写中-${stamp}` });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent = new AgentService({
      stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
        const text = latestUser(messages);
        if (text.includes(`插话-${stamp}`)) {
          yield { text: '现在可以继续。' };
          return;
        }
        if (messages.some((message) => message.role === 'tool')) {
          await gate;
          yield { text: '这句不该再占着输出。' };
          return;
        }
        yield { text: '我准备修改。', toolCalls: [{ id: `call-hold-${stamp}`, name: 'propose_changes', arguments: { summary: '改标题', operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: item.id, expectedRevision: item.revision, input: { title: `续写后-${stamp}` } } }] } }] };
      }),
    } as never);
    try {
      const first = await agent.chat({ message: `续写中改标题-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-hold-${stamp}` });
      const event = approvalFrom(first.events);
      const approved = await decide(agent, event);
      expect(approved.resumed).toBe(true);
      const streaming = await waitForRow(async () => prisma.message.findFirst({ where: { conversationId: first.conversationId, role: 'assistant', status: 'streaming' } }));
      expect(streaming?.content).toBe('');
      const next = await agent.chat({ conversationId: first.conversationId, message: `插话-${stamp}`, pageContext: { page: 'inbox' }, requestKey: `review-cutin-${stamp}` });
      expect(next.events.some((item) => item.type === 'message_end')).toBe(true);
      expect((await prisma.message.findUniqueOrThrow({ where: { id: streaming!.id } })).status).toBe('completed');
      expect((await freshTask(item.id)).title).toBe(`续写后-${stamp}`);
      const followUp = next.events.find((item) => item.type === 'message_delta');
      expect(JSON.stringify(followUp)).toContain('现在可以继续。');
    } finally {
      release();
    }
  });
});
