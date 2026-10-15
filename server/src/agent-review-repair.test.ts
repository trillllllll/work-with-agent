import { describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { approveAppChanges, repreviewApproval } from './agent/decision.js';
import { compileChangeOperations } from './agent/propose.js';
import type { ChangeOperation } from './agent/capabilities.js';

const now = () => new Date().toISOString();
const baseContext = {
  schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', referencedApprovalId: null as string | null,
};

function agent(reply: (messages: ModelMessage[]) => AsyncGenerator<{ text?: string; toolCalls?: ToolCall[] }>) {
  return new AgentService({ stream: reply } as never);
}

function afterLatestUser(messages: ModelMessage[]) {
  let start = 0;
  messages.forEach((message, index) => { if (message.role === 'user') start = index + 1; });
  return messages.slice(start);
}

async function proposalFor(taskId: string, revision: number, title: string, key: string) {
  const service = agent(async function* (messages) {
    if (messages.some((message) => message.role === 'tool')) { yield { text: '方案已生成。' }; return; }
    yield { toolCalls: [{ id: `call-${key}`, name: 'propose_changes', arguments: { summary: title, operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: taskId, expectedRevision: revision, input: { title } } }] } }] };
  });
  const chat = await service.chat({ message: title, pageContext: { page: 'inbox' }, requestKey: key });
  const approvalId = chat.events.find((event) => event.type === 'approval_required')?.approvalId;
  expect(approvalId).toBeTruthy();
  return { conversationId: chat.conversationId!, approvalId: approvalId! };
}

describe('repreview and adjustment', () => {
  it('compiles memory evidence and chat excerpts using the existing transaction connection', async () => {
    const task = await prisma.task.create({ data: { title: '事务证据', createdAt: now(), updatedAt: now() } });
    const conversation = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '事务中的聊天事实', status: 'completed', createdAt: now() } });
    const memory = await prisma.memory.create({ data: { kind: 'fact', title: '旧标题', content: '旧事实', createdAt: now(), updatedAt: now() } });
    try {
      const cases: Array<Extract<ChangeOperation, { family: 'memory' }>['args']> = [
        { action: 'add', target: 'inbox', title: '新标题', content: '新事实' },
        { action: 'add', target: 'inbox', title: '证据标题', content: '证据事实', evidence: [{ type: 'task', id: task.id }] },
        { action: 'replace', target: 'inbox', memoryId: memory.id, expectedRevision: 1, title: '替换标题', content: '替换事实' },
        { action: 'remove', target: 'inbox', memoryId: memory.id, expectedRevision: 1 },
      ];
      for (const args of cases) {
        const compiled = await prisma.$transaction((tx) => compileChangeOperations([{ family: 'memory', args }], { conversationId: conversation.id, topicId: null }, tx));
        expect(compiled.commands.some((command) => command.kind.startsWith('memory.'))).toBe(true);
        expect(compiled.commands.some((command) => command.kind === 'material.create')).toBe(!('evidence' in args));
      }
      expect((await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } })).content).toBe('旧事实');
    } finally {
      await prisma.memory.delete({ where: { id: memory.id } });
      await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
      await prisma.conversation.delete({ where: { id: conversation.id } });
      await prisma.task.delete({ where: { id: task.id } });
    }
  });

  it('creates one replacement for a request key and keeps the old card when generation fails', async () => {
    const task = await prisma.task.create({ data: { title: `重预览样本-${Date.now()}`, createdAt: now(), updatedAt: now() } });
    const first = await proposalFor(task.id, task.revision, '第一版标题', `repreview-${task.id}`);
    const created = await repreviewApproval(first.approvalId, { requestKey: 'same-preview' });
    const repeated = await repreviewApproval(first.approvalId, { requestKey: 'same-preview' });
    expect(created.approvalId).not.toBe(first.approvalId);
    expect(repeated.approvalId).toBe(created.approvalId);
    expect(created.approval).toMatchObject({ id: created.approvalId, status: 'pending' });
    expect(await prisma.approval.count({ where: { conversationId: first.conversationId } })).toBe(2);
    const old = await prisma.approval.findUniqueOrThrow({ where: { id: first.approvalId } });
    expect(old.status).toBe('rejected');
    const envelope = JSON.parse(old.result ?? '{}') as { proposalRevision?: number; supersededByApprovalId?: string; review?: { previewHash?: string } };
    expect(envelope.supersededByApprovalId).toBe(created.approvalId);
    await expect(approveAppChanges(first.approvalId, { expectedProposalRevision: envelope.proposalRevision, previewHash: envelope.review?.previewHash })).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_HANDLED' });

    const pending = await proposalFor(task.id, task.revision, '仍待确认', `repreview-fail-${task.id}`);
    const row = await prisma.approval.findUniqueOrThrow({ where: { id: pending.approvalId } });
    const stored = JSON.parse(row.result ?? '{}') as { requestedOperations: unknown[] };
    stored.requestedOperations = [{ family: 'workspace', command: { kind: 'topic.create', input: { name: '清单', extra: true } } }];
    await prisma.approval.update({ where: { id: row.id }, data: { result: JSON.stringify(stored) } });
    await expect(repreviewApproval(row.id, { requestKey: 'broken-preview' })).rejects.toBeTruthy();
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
    expect(await prisma.approval.count({ where: { conversationId: pending.conversationId } })).toBe(1);
  });

  it('supersedes a pending proposal in the same conversation and rejects a foreign reference', async () => {
    const task = await prisma.task.create({ data: { title: `调整样本-${Date.now()}`, createdAt: now(), updatedAt: now() } });
    const original = await proposalFor(task.id, task.revision, '调整前标题', `adjust-${task.id}`);
    let sawReference = false;
    const adjusting = agent(async function* (messages) {
      sawReference = JSON.stringify(messages).includes(original.approvalId) && JSON.stringify(messages).includes('不要直接执行');
      if (afterLatestUser(messages).some((message) => message.role === 'tool')) { yield { text: '新方案已生成。' }; return; }
      yield { toolCalls: [{ id: 'call-adjust', name: 'propose_changes', arguments: { summary: '调整后标题', operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '调整后标题' } } }] } }] };
    });
    const adjusted = await adjusting.chat({
      conversationId: original.conversationId,
      message: '把标题改短',
      requestKey: `adjust-next-${task.id}`,
      context: { ...baseContext, referencedApprovalId: original.approvalId },
    });
    expect(sawReference).toBe(true);
    const nextId = adjusted.events.find((event) => event.type === 'approval_required')?.approvalId;
    expect(nextId && nextId !== original.approvalId).toBe(true);
    const replaced = await prisma.approval.findUniqueOrThrow({ where: { id: original.approvalId } });
    expect(replaced.status).toBe('rejected');
    const replacedEnvelope = JSON.parse(replaced.result ?? '{}') as { proposalRevision?: number; review?: { previewHash?: string } };
    await expect(approveAppChanges(original.approvalId, { expectedProposalRevision: replacedEnvelope.proposalRevision, previewHash: replacedEnvelope.review?.previewHash })).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_HANDLED' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(task.title);

    const explaining = agent(async function* () { yield { text: '我只解释这份方案。' }; });
    const explained = await proposalFor(task.id, task.revision, '解释前标题', `explain-${task.id}`);
    await explaining.chat({ conversationId: explained.conversationId, message: '只解释', requestKey: `explain-next-${task.id}`, context: { ...baseContext, referencedApprovalId: explained.approvalId } });
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: explained.approvalId } })).status).toBe('pending');

    const failing = agent(async function* () { throw new Error('生成失败'); });
    const failed = await proposalFor(task.id, task.revision, '失败前标题', `fail-adjust-${task.id}`);
    await failing.chat({ conversationId: failed.conversationId, message: '这次会失败', requestKey: `fail-adjust-next-${task.id}`, context: { ...baseContext, referencedApprovalId: failed.approvalId } });
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: failed.approvalId } })).status).toBe('pending');

    const other = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    const before = await prisma.message.count({ where: { conversationId: other.id } });
    const foreign = agent(async function* () { yield { text: '不该执行。' }; });
    await expect(foreign.chat({ conversationId: other.id, message: '引用别的会话', requestKey: `foreign-${task.id}`, context: { ...baseContext, referencedApprovalId: original.approvalId } })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(await prisma.message.count({ where: { conversationId: other.id } })).toBe(before);
  });
});
