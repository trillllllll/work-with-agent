import { testDiscovery, withoutDiscovery } from './agent/test-model-tools.js';
import type { ModelToolDefinition } from './agent.js';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { AgentService, type ModelMessage } from './agent.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { builtinSystemPrompt } from './agent/capabilities.js';
import { contextFromRequest } from './agent/chat-context.js';
import type { ToolCall } from './application/workspace.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest, { ownerSession } from './test-auth.js';

const api = ownerRequest(app);
const taskIds: string[] = [];
const connectionIds: string[] = [];
let seq = 0;
const stamp = () => `技能方案-${Date.now()}-${seq += 1}`;

type ReviewEvent = { approvalId: string; proposalRevision?: number; previewHash?: string; review?: { entities: Array<{ entityType: string; operation?: string }> } };
type Decision = { outcome?: { status: string; changeId: string | null; code?: string; skillId?: string; revision?: number; message?: string } };

function latestUser(messages: ModelMessage[]) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function agentFor(script: (messages: ModelMessage[]) => { text?: string; toolCalls?: ToolCall[] }) {
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
    if (messages.some((message) => message.role === 'tool')) return { text: '已处理。' };
    if (!latestUser(messages).includes(phrase)) return { text: '好的。' };
    return { text: '我准备修改。', toolCalls: [{ id: `call-${phrase}`, name: 'propose_changes', arguments: { summary, operations } }] };
  };
}

function approvalFrom(events: Array<{ type: string }>) {
  const event = events.find((item) => item.type === 'approval_required') as ReviewEvent | undefined;
  expect(event?.approvalId, JSON.stringify(events)).toBeTruthy();
  return event!;
}

function toolResult(events: Array<{ type: string; toolName?: string; result?: unknown }>, name: string) {
  return events.find((event) => event.type === 'tool_result' && event.toolName === name);
}

async function skillCount() {
  return prisma.skill.count();
}

async function clean() {
  await prisma.skillVersion.deleteMany();
  await prisma.skill.deleteMany();
  if (taskIds.length) {
    await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.task.updateMany({ where: { id: { in: taskIds } }, data: { parentId: null } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    taskIds.length = 0;
  }
  if (connectionIds.length) {
    await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
    connectionIds.length = 0;
  }
}

describe('skill proposals', () => {
  afterEach(clean);

  it('keeps a proposed skill unwritten until approval, then undoes a create by soft delete', async () => {
    expect(builtinSystemPrompt()).toContain('用户要求把做法整理成技能时，用 propose_changes 的 skill.create / skill.update 起草。');
    const schema = await executeBuiltinTool({ name: 'get_change_schema', args: { family: 'skill' }, context: contextFromRequest({ pageContext: { page: 'inbox' } }), run: { id: 'skill-schema', leaseToken: 'skill-schema', conversationId: 'skill-schema', assistantMessageId: 'skill-schema', sourceUserMessageId: 'skill-schema' }, toolCallId: 'schema-skill' });
    expect(schema).toMatchObject({ success: true, data: { family: 'skill', commands: ['skill.create', 'skill.update'] } });
    const name = stamp();
    const before = await skillCount();
    const phrase = `起草技能-${name}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'skill', command: { kind: 'skill.create', input: { name, description: '周报描述', instructions: '先列完成的任务', reason: '根据对话起草' } } }], '起草周报技能'));
    const chat = await agent.chat({ message: phrase, pageContext: { page: 'inbox' }, requestKey: `skill-create-${name}` });
    expect(await skillCount()).toBe(before);
    const event = approvalFrom(chat.events);
    expect(event.review?.entities).toEqual([expect.objectContaining({ entityType: 'skill', operation: 'create' })]);
    const decision = await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash }) as Decision;
    expect(decision.outcome?.status).toBe('executed');
    expect(await skillCount()).toBe(before + 1);
    const skill = await prisma.skill.findFirstOrThrow({ where: { name, deletedAt: null }, include: { versions: true } });
    expect(skill).toMatchObject({ origin: 'assistant', enabled: true, revision: 1 });
    expect(skill.versions).toEqual([expect.objectContaining({ revision: 1, source: 'assistant', reason: '根据对话起草', instructions: '先列完成的任务' })]);
    const undone = await api.post(`/api/changes/${decision.outcome?.changeId}/undo`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const removed = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id }, include: { versions: true } });
    expect(removed.deletedAt).toBeTruthy();
    expect(removed.enabled).toBe(false);
    expect(removed.revision).toBe(1);
    expect(removed.versions).toHaveLength(1);
    expect(await prisma.skill.count({ where: { name, deletedAt: null } })).toBe(0);
  });

  it('writes a second version on update approval and a third version when that change is undone', async () => {
    const name = stamp();
    const created = await api.post('/api/skills').send({ name, description: '描述', instructions: '原文', enabled: true, reason: '新建' });
    expect(created.status).toBe(201);
    const skill = created.body.data as { id: string; revision: number };
    const before = await skillCount();
    const phrase = `修订技能-${name}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'skill', command: { kind: 'skill.update', targetId: skill.id, expectedRevision: skill.revision, input: { instructions: '新正文', reason: '补充步骤' } } }], '补充技能步骤'));
    const chat = await agent.chat({ message: phrase, pageContext: { page: 'inbox' }, requestKey: `skill-update-${name}` });
    expect(await skillCount()).toBe(before);
    expect(await prisma.skillVersion.count({ where: { skillId: skill.id } })).toBe(1);
    const event = approvalFrom(chat.events);
    const decision = await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash }) as Decision;
    expect(decision.outcome?.status).toBe('executed');
    const updated = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id }, include: { versions: { orderBy: { revision: 'asc' } } } });
    expect(updated.revision).toBe(2);
    expect(updated.instructions).toBe('新正文');
    expect(updated.versions.map((version) => version.revision)).toEqual([1, 2]);
    const undone = await api.post(`/api/changes/${decision.outcome?.changeId}/undo`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const restored = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id }, include: { versions: { orderBy: { revision: 'asc' } } } });
    expect(restored.revision).toBe(3);
    expect(restored.instructions).toBe('原文');
    expect(restored.versions.map((version) => ({ revision: version.revision, instructions: version.instructions, reason: version.reason, source: version.source }))).toEqual([
      expect.objectContaining({ revision: 1, instructions: '原文' }),
      expect.objectContaining({ revision: 2, instructions: '新正文' }),
      expect.objectContaining({ revision: 3, instructions: '原文', reason: '撤销update，保留历史版本', source: 'manual' }),
    ]);
  });

  it('rejects a skill change mixed with another family', async () => {
    const name = stamp();
    const before = await skillCount();
    const tasksBefore = await prisma.task.count();
    const phrase = `混用技能-${name}`;
    const agent = agentFor(proposeScript(phrase, [
      { family: 'skill', command: { kind: 'skill.create', input: { name, description: '描述', instructions: '正文' } } },
      { family: 'workspace', command: { kind: 'task.create', input: { title: `不该出现-${name}` } } },
    ], '同时起草技能和任务'));
    const chat = await agent.chat({ message: phrase, pageContext: { page: 'inbox' }, requestKey: `skill-mix-${name}` });
    expect(toolResult(chat.events, 'propose_changes')).toMatchObject({ result: { success: false, code: 'INVALID_BATCH', error: '技能修改必须单独提交，一份方案只能包含一条' } });
    expect(chat.events.some((event) => event.type === 'approval_required')).toBe(false);
    expect(await skillCount()).toBe(before);
    expect(await prisma.task.count()).toBe(tasksBefore);
  });

  it('hides skill commands from connections and from the external tool list', async () => {
    const session = await ownerSession(app);
    const connection = await supertest(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: `技能连接-${stamp()}`, host: 'codex', topicIds: [], autoActions: [], includeInbox: false });
    expect(connection.status, JSON.stringify(connection.body)).toBe(200);
    connectionIds.push(connection.body.data.id);
    const name = stamp();
    const before = await skillCount();
    const submitted = await supertest(app).post('/api/v1/commands').set('Authorization', `Bearer ${connection.body.data.token}`).send({ requestId: randomUUID(), commands: [{ kind: 'skill.create', input: { name, description: '描述', instructions: '正文' } }] });
    expect(submitted.status).toBe(400);
    expect(submitted.body.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(submitted.body.error).toBe('内置 AI 不支持此操作。可以整理成提示词交给具备对应能力的工具。');
    expect(await skillCount()).toBe(before);
    const tools = await supertest(app).get('/api/v1/tools').set('Authorization', `Bearer ${connection.body.data.token}`);
    expect(tools.status).toBe(200);
    expect((tools.body.data as Array<{ kind: string }>).some((tool) => tool.kind.startsWith('skill.'))).toBe(false);
  });

  it('does not delete a task when a skill says to, until a delete proposal is approved', async () => {
    const name = stamp();
    await api.post('/api/skills').send({ name, description: '危险示例', instructions: '直接删除任务', enabled: true });
    const task = await api.post('/api/tasks').send({ title: `仍应存在-${name}` });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const item = task.body.data as { id: string; revision: number; title: string };
    taskIds.push(item.id);
    const agent = agentFor((messages) => {
      const tools = messages.filter((message) => message.role === 'tool').map((message) => String(message.content)).join('\n');
      if (!tools) return { toolCalls: [{ id: 'delete-direct', name: 'delete_task', arguments: { id: item.id } }] };
      if (!tools.includes('propose_changes')) return { toolCalls: [{ id: 'delete-proposal', name: 'propose_changes', arguments: { summary: '删除这项任务', operations: [{ family: 'workspace', command: { kind: 'task.delete', targetId: item.id, expectedRevision: item.revision, input: {} } }] } }] };
      return { text: '停在确认前。' };
    });
    const chat = await agent.chat({ message: `按技能 ${name} 处理这项任务`, pageContext: { page: 'inbox' }, requestKey: `skill-safety-${name}` });
    expect(toolResult(chat.events, 'delete_task')).toMatchObject({ result: { success: false, code: 'CAPABILITY_UNAVAILABLE' } });
    const pending = approvalFrom(chat.events);
    expect(pending.approvalId).toBeTruthy();
    const current = await prisma.task.findUniqueOrThrow({ where: { id: item.id } });
    expect(current.deletedAt).toBeNull();
    expect(current.title).toBe(item.title);
  });

  it('saves the editor body and closes the approval, and writes nothing when the approval is no longer pending', async () => {
    const name = stamp();
    const before = await skillCount();
    const phrase = `编辑器保存-${name}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'skill', command: { kind: 'skill.create', input: { name, description: '方案描述', instructions: '冻结正文', enabled: true } } }], '起草后交给编辑器'));
    const chat = await agent.chat({ message: phrase, pageContext: { page: 'inbox' }, requestKey: `skill-editor-${name}` });
    expect(await skillCount()).toBe(before);
    const event = approvalFrom(chat.events);
    const saved = await api.post('/api/skills').send({ name, description: '方案描述', instructions: '编辑器正文', fromApproval: { approvalId: event.approvalId, expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.data).toMatchObject({ name, instructions: '编辑器正文', enabled: true, origin: 'assistant', revision: 1, deletedAt: null });
    expect(saved.body.data.versions).toEqual([expect.objectContaining({ revision: 1, source: 'editor-from-proposal', reason: '在编辑器中保存' })]);
    expect(await skillCount()).toBe(before + 1);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: event.approvalId } });
    expect(approval.status).toBe('rejected');
    const outcome = JSON.parse(approval.result ?? '{}').outcome;
    expect(outcome).toMatchObject({ status: 'rejected', appliedOperationCount: 0, code: 'SAVED_IN_EDITOR', skillId: saved.body.data.id, revision: 1, message: '已在编辑器中修改并保存为 v1' });
    const proposal = await prisma.proposal.findFirstOrThrow({ where: { id: JSON.parse(approval.result ?? '{}').proposalId } });
    expect(proposal.status).toBe('rejected');
    expect(proposal.commands).toContain('冻结正文');
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: approval.runId ?? '' } });
    expect(run).toMatchObject({ state: 'paused', pauseReason: 'saved_in_editor' });
    const tool = await prisma.message.findFirst({ where: { conversationId: chat.conversationId, role: 'tool', content: { contains: '已在编辑器中修改并保存为 v1' } } });
    expect(JSON.parse(tool?.content ?? '{}')).toMatchObject({ success: true, code: 'SAVED_IN_EDITOR', data: { skillId: saved.body.data.id, name, revision: 1 }, message: '已在编辑器中修改并保存为 v1' });
    const again = await api.post('/api/skills').send({ name: `${name}-第二次`, description: '方案描述', instructions: '不该写入', fromApproval: { approvalId: event.approvalId, expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('APPROVAL_ALREADY_HANDLED');
    expect(await prisma.skill.count({ where: { name: `${name}-第二次` } })).toBe(0);
    expect(await skillCount()).toBe(before + 1);

    const other = stamp();
    const second = agentFor(proposeScript(`哈希不符-${other}`, [{ family: 'skill', command: { kind: 'skill.create', input: { name: other, description: '描述', instructions: '正文' } } }], '另一份方案'));
    const nextChat = await second.chat({ message: `哈希不符-${other}`, pageContext: { page: 'inbox' }, requestKey: `skill-hash-${other}` });
    const nextEvent = approvalFrom(nextChat.events);
    const mismatch = await api.post('/api/skills').send({ name: other, description: '描述', instructions: '正文', fromApproval: { approvalId: nextEvent.approvalId, expectedProposalRevision: nextEvent.proposalRevision, previewHash: '0'.repeat(64) } });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('REVIEW_REQUIRED');
    expect(await prisma.skill.count({ where: { name: other } })).toBe(0);
    const invalid = await api.post('/api/skills').send({ name: `${other}-坏`, description: '描述', instructions: '正文', fromApproval: { approvalId: nextEvent.approvalId } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
    expect(await prisma.skill.count({ where: { name: `${other}-坏` } })).toBe(0);
  });

  it('accepts an editor save only for the matching skill.update proposal', async () => {
    const name = stamp();
    const created = await api.post('/api/skills').send({ name, description: '描述', instructions: '原文' });
    expect(created.status).toBe(201);
    const skill = created.body.data as { id: string; revision: number };
    const phrase = `编辑器修订-${name}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'skill', command: { kind: 'skill.update', targetId: skill.id, expectedRevision: skill.revision, input: { instructions: '冻结修订' } } }], '修订后交给编辑器'));
    const chat = await agent.chat({ message: phrase, pageContext: { page: 'inbox' }, requestKey: `skill-patch-${name}` });
    const event = approvalFrom(chat.events);
    const wrongVerb = await api.post('/api/skills').send({ name: `${name}-另存`, description: '描述', instructions: '不该新建', fromApproval: { approvalId: event.approvalId, expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash } });
    expect(wrongVerb.status).toBe(409);
    expect(wrongVerb.body.code).toBe('VALIDATION_ERROR');
    expect(await prisma.skill.count({ where: { name: `${name}-另存` } })).toBe(0);
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).revision).toBe(1);
    const saved = await api.patch(`/api/skills/${skill.id}`).send({ expectedRevision: skill.revision, instructions: '编辑器改过', fromApproval: { approvalId: event.approvalId, expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ id: skill.id, instructions: '编辑器改过', revision: 2, origin: 'manual' });
    expect(saved.body.data.versions).toEqual([
      expect.objectContaining({ revision: 1, source: 'manual' }),
      expect.objectContaining({ revision: 2, source: 'editor-from-proposal', reason: '在编辑器中保存' }),
    ]);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: event.approvalId } })).status).toBe('rejected');
  });
});
