import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import './app.js';
import { AgentService, type ModelMessage } from './agent.js';
import { prisma } from './infrastructure/prisma.js';
import { startChat } from './agent/runs.js';
import { contextFromRequest, validateScopeAndResolveIds } from './agent/chat-context.js';
import { resolveAssistantSource, sourcesFromTool } from './agent/assistant-sources.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { readPracticeItem } from './application/learning-practice/read.js';
import { submitPracticeAttempt } from './application/learning-practice/service.js';
import { CommandService } from './application/commands.js';
import { ownerActor } from './application/security.js';
import type { ChatAttachment } from './domain/chat-context.js';

const maps: string[] = [];
const sessions: string[] = [];
const conversations = new Set<string>();
const id = () => `study-integration:${randomUUID()}`;
async function fixture() {
  const timestamp = new Date().toISOString();
  const map = await prisma.learningMap.create({ data: { id: id(), title: '测试主题', goal: '理解数据流', createdAt: timestamp, updatedAt: timestamp } });
  maps.push(map.id);
  const node = await prisma.learningNode.create({ data: { id: id(), mapId: map.id, kind: 'item', title: '闭包', detail: '公开知识笔记', createdAt: timestamp, updatedAt: timestamp } });
  const question = await prisma.learningQuestion.create({ data: { id: id(), mapId: map.id, nodeId: node.id, currentVersionId: id(), createdAt: timestamp } });
  const version = await prisma.learningQuestionVersion.create({ data: { id: question.currentVersionId, questionId: question.id, nodeId: node.id, nodeTitle: node.title, contentJson: JSON.stringify({ nodeId: node.id, type: 'single', prompt: '哪种情况构成闭包？', options: [{ id: 'A', text: '保留词法环境' }, { id: 'B', text: '创建空对象' }], answer: 'A', explanation: 'PRIVATE_SOLUTION', rubric: 'PRIVATE_RUBRIC', hints: ['考虑函数作用域'], difficulty: 'easy', objective: '理解闭包', source: { kind: 'note', label: node.title, nodeRevision: 1 } }), promptVersion: 'fixture', createdAt: timestamp } });
  const session = await prisma.learningPracticeSession.create({ data: { id: id(), ownerId: 'local-owner', mapId: map.id, mapTitle: map.title, generationJobId: id(), mode: 'knowledge', configJson: '{}', createdAt: timestamp, updatedAt: timestamp } });
  sessions.push(session.id);
  const item = await prisma.learningPracticeItem.create({ data: { id: id(), sessionId: session.id, questionVersionId: version.id, position: 0, selectionReason: 'selected_knowledge' } });
  const draft = await prisma.learningAnswerDraft.create({ data: { id: id(), itemId: item.id, activeAttemptId: id(), updatedAt: timestamp } });
  const attachment: ChatAttachment = { id: id(), kind: 'draft', title: '闭包题目', text: '我的未提交答案：不确定', unsaved: true, learningMapId: map.id, learningNodeId: node.id, learningSessionId: session.id, learningItemId: item.id, learningAttemptId: draft.activeAttemptId, learningIntent: 'hint' };
  return { map, node, question, version, session, item, draft, attachment };
}
function context(attachments: ChatAttachment[]) {
  return { schemaVersion: 3, page: 'learning', scope: { kind: 'all' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', referencedApprovalId: null, label: '学习', section: null, mode: 'follow', taskRevision: null, materialRevision: null, selectedMaterialIds: [], pageState: {}, attachments };
}
async function ask(agent: AgentService, attachments: ChatAttachment[], message = '给我一点提示') {
  const result = await agent.chat({ identityId: 'study', message, requestKey: id(), context: context(attachments) });
  if (result.conversationId) conversations.add(result.conversationId);
  return result;
}
async function submit(f: Awaited<ReturnType<typeof fixture>>) {
  return submitPracticeAttempt(f.item.id, { requestId: id(), activeAttemptId: f.draft.activeAttemptId, expectedDraftRevision: 1, questionVersionId: f.version.id, clientAttemptId: id(), answer: 'A' });
}
afterEach(async () => {
  const runs = await prisma.agentRun.findMany({ where: { requestKey: { startsWith: 'study-integration:' } }, select: { conversationId: true } });
  for (const run of runs) conversations.add(run.conversationId);
  await prisma.conversation.deleteMany({ where: { id: { in: [...conversations] } } });
  conversations.clear();
  for (const table of ['learningReviewEvent', 'learningReviewItem', 'learningPracticeEvent', 'learningGrade', 'learningAttempt', 'learningAnswerDraft', 'learningPracticeItem', 'learningPracticeSession', 'learningJob', 'learningQuestionVersion', 'learningQuestion', 'learningResumeState'] as const) await (prisma[table] as { deleteMany(): Promise<unknown> }).deleteMany();
  await prisma.learningActivity.deleteMany({ where: { mapId: { in: maps } } });
  await prisma.learningNode.deleteMany({ where: { mapId: { in: maps } } });
  await prisma.learningMap.deleteMany({ where: { id: { in: maps } } });
  await prisma.requestReceipt.deleteMany({ where: { requestId: { startsWith: 'study-integration:' } } });
  maps.length = 0; sessions.length = 0;
});

describe('study assistant and persistent practice', () => {
  it('validates checkpoint metadata and sources before saving a confirmed learning record', async () => {
    const f = await fixture();
    const commands = new CommandService();
    const input = { mapId: f.map.id, nodeId: f.node.id, kind: 'session', content: '理解了闭包；下一步做应用题。', meta: { schemaVersion: 1, type: 'checkpoint', unresolvedQuestions: ['何时释放词法环境？'], nextStep: '完成一道应用题', sources: [{ kind: 'session', id: f.session.id }] } };
    await expect(commands.submit(ownerActor, { requestId: id(), commands: [{ kind: 'learning.activity.append', input: { ...input, meta: { ...input.meta, schemaVersion: 2 } } }] })).rejects.toBeTruthy();
    await expect(commands.submit(ownerActor, { requestId: id(), commands: [{ kind: 'learning.activity.append', input: { ...input, meta: { ...input.meta, sources: [{ kind: 'attempt', id: 'invented' }] } } }] })).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT_SOURCE' });
    expect(await prisma.learningActivity.count({ where: { mapId: f.map.id } })).toBe(0);
    const result = await commands.submit(ownerActor, { requestId: id(), commands: [{ kind: 'learning.activity.append', input }] });
    expect(result.status).toBe('applied');
    const saved = await prisma.learningActivity.findFirstOrThrow({ where: { mapId: f.map.id } });
    expect(JSON.parse(saved.metaJson)).toMatchObject({ ...input.meta, confirmation: { kind: 'user', actorId: ownerActor.id } });
  });

  it('keeps an assistant checkpoint out of saved progress until its proposal is approved', async () => {
    const f = await fixture();
    const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
      if (messages.some(message => message.role === 'tool')) yield { text: '收尾记录等待确认。' };
      else yield { toolCalls: [{ id: 'checkpoint', name: 'propose_changes', arguments: { summary: '保存本次学习收尾', operations: [{ family: 'learning', args: { action: 'activity_append', mapId: f.map.id, nodeId: f.node.id, kind: 'session', content: '仍需练习闭包释放时机。', meta: { schemaVersion: 1, type: 'checkpoint', sources: [{ kind: 'session', id: f.session.id }] } } }] } }] };
    } } as never);
    const response = await ask(agent, [], '整理这次收获');
    const approval = response.events.find(event => event.type === 'approval_required') as any;
    expect(approval).toBeTruthy();
    expect(await prisma.learningActivity.count({ where: { mapId: f.map.id } })).toBe(0);
    await agent.approve(approval.approvalId, { expectedProposalRevision: approval.proposalRevision, previewHash: approval.previewHash });
    const record = await prisma.learningActivity.findFirstOrThrow({ where: { mapId: f.map.id } });
    expect(JSON.parse(record.metaJson)).toMatchObject({ schemaVersion: 1, type: 'checkpoint', confirmation: { kind: 'approval', actorId: ownerActor.id, approvalId: approval.approvalId } });
  });

  it('freezes and validates genuine references before creating an assistance request', async () => {
    const f = await fixture();
    const valid = { ...contextFromRequest({ context: context([f.attachment]) }), identityId: 'study' as const };
    expect(await validateScopeAndResolveIds(valid)).toMatchObject({ attachments: [f.attachment] });
    await expect(validateScopeAndResolveIds({ ...valid, identityId: 'work' })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    const other = await fixture();
    await expect(validateScopeAndResolveIds({ ...valid, schemaVersion: 3, attachments: [{ ...f.attachment, learningSessionId: other.session.id }] } as typeof valid)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(await prisma.learningPracticeEvent.count()).toBe(0);
    const requestKey = id();
    const first = await startChat({ identityId: 'study', message: '给我提示', context: context([f.attachment]), requestKey });
    const replay = await startChat({ identityId: 'study', message: '给我提示', context: context([f.attachment]), requestKey });
    expect(replay.id).toBe(first.id);
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_requested' } })).toBe(1);
    expect(await prisma.learningResumeState.findUnique({ where: { ownerId: 'local-owner' } })).toMatchObject({ nodeId: f.node.id });
    expect((await submit(f)).attempt).toMatchObject({ assisted: false, assistanceUncertain: true });
  });

  it('records actual streamed help once before exposing it, without granting the model hidden answers', async () => {
    const f = await fixture();
    const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
      expect(JSON.stringify(messages)).not.toContain('PRIVATE_SOLUTION');
      expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_requested' } })).toBe(1);
      yield { text: '先思考函数' }; yield { text: '的词法作用域。' };
    } } as never);
    const result = await ask(agent, [f.attachment]);
    expect(result.events.some(event => event.type === 'message_delta')).toBe(true);
    expect(await prisma.learningPracticeEvent.findMany({ where: { itemId: f.item.id }, select: { type: true } })).toEqual(expect.arrayContaining([{ type: 'assistance_requested' }, { type: 'assistance_delivered' }]));
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_delivered' } })).toBe(1);
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_failed' } })).toBe(0);
    expect((await submit(f)).attempt).toMatchObject({ assisted: true, assistanceUncertain: false, solutionViewed: false });
  });

  it('records a failed request without inventing delivered assistance', async () => {
    const f = await fixture();
    const agent = new AgentService({ stream: async function* () { yield { reasoning: '准备解释' }; throw new Error('fixture model unavailable'); } } as never);
    await ask(agent, [f.attachment]);
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_failed' } })).toBe(1);
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_delivered' } })).toBe(0);
    expect((await submit(f)).attempt).toMatchObject({ assisted: false, assistanceUncertain: false });
  });

  it('records visible rich reply solutions but never counts an incomplete tool JSON as help', async () => {
    const f = await fixture();
    const args = JSON.stringify({ blocks: [{ type: 'text', studySupport: 'solution', markdown: '解析：函数保留创建时的词法环境。' }] });
    const agent = new AgentService({ stream: async function* () {
      yield { toolDelta: { index: 0, name: 'present_reply', argumentsDelta: args } };
      yield { toolCalls: [{ id: 'reply', name: 'present_reply', arguments: JSON.parse(args) }] };
    } } as never);
    const rich = await ask(agent, [f.attachment], '请用图表讲解解析');
    expect(await prisma.learningPracticeEvent.count({ where: { type: 'assistance_solution' } }), JSON.stringify(rich.events)).toBe(1);
    expect((await submit(f)).attempt).toMatchObject({ assisted: true, solutionViewed: true });
    const second = await fixture();
    const broken = new AgentService({ stream: async function* () {
      yield { toolDelta: { index: 0, name: 'present_reply', argumentsDelta: '{"blocks":[' } };
      throw new Error('no content received');
    } } as never);
    await ask(broken, [second.attachment], '请用图表提示');
    expect(await prisma.learningPracticeEvent.count({ where: { itemId: second.item.id, type: 'assistance_delivered' } })).toBe(0);
  });

  it('reads public practice tools and immutable source text without leaking grading inputs', async () => {
    const f = await fixture();
    const input = { name: 'learning_read', args: { action: 'practice_item', itemId: f.item.id }, context: { ...contextFromRequest({ context: context([]) }), identityId: 'study' as const }, run: { id: '', leaseToken: '', conversationId: '', assistantMessageId: '', sourceUserMessageId: '' }, toolCallId: 'read' };
    const read = await executeBuiltinTool(input);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read)).not.toMatch(/PRIVATE_|rubric/);
    expect((await executeBuiltinTool({ ...input, context: { ...input.context, identityId: 'work' } })).code).toBe('CAPABILITY_UNAVAILABLE');
    const sources = await sourcesFromTool('learning_read', input.args, read);
    expect(sources).toEqual([expect.objectContaining({ kind: 'learning_item', id: f.item.id })]);
    const source = await resolveAssistantSource('learning_item', f.item.id);
    expect(source.content).toContain('哪种情况构成闭包');
    expect(source.content).not.toMatch(/PRIVATE_|rubric/);
    expect(await readPracticeItem(f.item.id)).not.toHaveProperty('solution');
  });

  it('does not count an empty or whitespace-only rich solution as delivered help', async () => {
    for (const markdown of ['', '   \n']) {
      const f = await fixture();
      const args = { blocks: [{ type: 'text', studySupport: 'solution', markdown }] };
      const agent = new AgentService({ stream: async function* () {
        yield { toolDelta: { index: 0, name: 'present_reply', argumentsDelta: JSON.stringify(args) } };
        yield { toolCalls: [{ id: 'empty-reply', name: 'present_reply', arguments: args }] };
      } } as never);
      await ask(agent, [f.attachment], '请用富媒体讲解解析');
      expect(await prisma.learningPracticeEvent.count({ where: { itemId: f.item.id, type: { in: ['assistance_delivered', 'assistance_solution'] } } })).toBe(0);
      expect((await submit(f)).attempt).toMatchObject({ assisted: false, assistanceUncertain: false });
    }
  });

  it('creates a readable practice proposal and waits for approval before generating', async () => {
    const f = await fixture();
    const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
      if (messages.some(message => message.role === 'tool')) yield { text: '候选生成任务已建立，请到学习页查看。' };
      else yield { toolCalls: [{ id: 'generate', name: 'propose_changes', arguments: { summary: '生成三道闭包练习', operations: [{ family: 'learning', args: { action: 'practice_generate', mapId: f.map.id, nodeIds: [f.node.id], count: 3, types: ['single'], difficulty: 'easy' } }] } }] };
    } } as never);
    const response = await ask(agent, [], '出题：三道闭包单选');
    const approval = response.events.find(event => event.type === 'approval_required') as any;
    expect(approval, JSON.stringify(response.events)).toBeTruthy();
    expect(JSON.stringify(approval.review)).toContain('learning_practice_job');
    expect(JSON.stringify(approval.review)).toContain('题量');
    expect(JSON.stringify(approval.review)).not.toMatch(/PRIVATE_|rubric/);
    expect(await prisma.learningJob.count()).toBe(0);
    await agent.approve(approval.approvalId, { expectedProposalRevision: approval.proposalRevision, previewHash: approval.previewHash });
    expect(await prisma.learningJob.count({ where: { kind: 'generate', mapId: f.map.id } })).toBe(1);
    expect(await prisma.learningNode.findUnique({ where: { id: f.node.id } })).toMatchObject({ status: 'todo' });
  });
});
