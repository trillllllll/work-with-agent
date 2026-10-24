import { withTestToolLoading } from './agent/test-model-tools.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { ContextService } from './application/conversation.js';
import { bootRuns, resetRunSchedulerState, resumeRun } from './agent/runs.js';
import { recoverExpiredDecisions } from './agent/decision.js';

const now = () => new Date().toISOString();
const cursor = JSON.stringify({ schemaVersion: 1, phase: 'model', round: 0, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0 });
const context = JSON.stringify({ schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'default', referencedApprovalId: null });

async function conversationWith(content: string) {
  const timestamp = now();
  const conversation = await prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content, status: 'completed', createdAt: timestamp } });
  return { conversation, message, timestamp };
}

afterAll(() => { resetRunSchedulerState(); });

describe('agent run recovery', () => {
  it('allows only one active run per conversation', async () => {
    const first = await conversationWith('第一条');
    await prisma.agentRun.create({ data: { conversationId: first.conversation.id, sourceUserMessageId: first.message.id, requestKey: `active-a-${first.timestamp}`, requestHash: 'a', state: 'queued', contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt: first.timestamp, updatedAt: first.timestamp } });
    const secondMessage = await prisma.message.create({ data: { conversationId: first.conversation.id, role: 'user', content: '第二条', status: 'completed', createdAt: now() } });
    await expect(prisma.agentRun.create({ data: { conversationId: first.conversation.id, sourceUserMessageId: secondMessage.id, requestKey: `active-b-${first.timestamp}`, requestHash: 'b', state: 'running', contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt: now(), updatedAt: now() } })).rejects.toThrow();
    const paused = await prisma.agentRun.create({ data: { conversationId: first.conversation.id, sourceUserMessageId: secondMessage.id, requestKey: `paused-${first.timestamp}`, requestHash: 'c', state: 'paused', pauseReason: 'interrupted', contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt: now(), updatedAt: now() } });
    expect(paused.state).toBe('paused');
  });

  it('pauses an expired running lease on boot without regenerating that request', async () => {
    const stamp = `重启样本用户句-${Date.now()}`;
    const seeded = await conversationWith(stamp);
    const run = await prisma.agentRun.create({ data: { conversationId: seeded.conversation.id, sourceUserMessageId: seeded.message.id, requestKey: `lease-${seeded.timestamp}`, requestHash: 'lease', state: 'running', leaseToken: 'expired', leaseExpiresAt: new Date(Date.now() - 1000).toISOString(), contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt: seeded.timestamp, updatedAt: seeded.timestamp } });
    await prisma.conversation.update({ where: { id: seeded.conversation.id }, data: { activeRunId: run.id } });
    const seen: string[] = [];
    await bootRuns(async function* (messages: ModelMessage[]) {
      seen.push(JSON.stringify(messages));
      yield { text: '不应自动重做这个请求。' };
    }, new ContextService());
    const stored = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.state).toBe('paused');
    expect(stored.pauseReason).toBe('interrupted');
    expect(seen.join('\n')).not.toContain(stamp);
  });

  it('restores an expired claim from its receipt, or back to pending when no receipt exists', async () => {
    const agent = new AgentService({
      stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
        if (messages.some((message) => message.role === 'tool')) { yield { text: '还在等待。' }; return; }
        const task = await prisma.task.create({ data: { title: `回执样本-${Date.now()}`, description: '', createdAt: now(), updatedAt: now() } });
        const call: ToolCall = { id: 'call_claim', name: 'propose_changes', arguments: { summary: '改标题', operations: [{ family: 'workspace', command: { kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '已确认标题' } } }] } };
        yield { toolCalls: [call] };
      }),
    } as never);
    const first = await agent.chat({ message: '生成第一份待确认', pageContext: { page: 'inbox' }, requestKey: `claim-a-${Date.now()}` });
    const second = await agent.chat({ message: '生成第二份待确认', pageContext: { page: 'inbox' }, requestKey: `claim-b-${Date.now()}` });
    const pendingId = first.events.find((event) => event.type === 'approval_required')?.approvalId;
    const receiptId = second.events.find((event) => event.type === 'approval_required')?.approvalId;
    expect(pendingId).toBeTruthy();
    expect(receiptId).toBeTruthy();
    const pendingRow = await prisma.approval.findUniqueOrThrow({ where: { id: pendingId! } });
    const receiptRow = await prisma.approval.findUniqueOrThrow({ where: { id: receiptId! } });
    const revision = JSON.parse(receiptRow.result ?? '{}').proposalRevision as number;
    await prisma.requestReceipt.create({ data: { actorId: 'local-owner', requestId: `builtin-decision:${receiptRow.id}:${revision}:approve`, requestHash: 'same', response: JSON.stringify({ outcome: { status: 'executed', changeId: 'claimed-change' } }), createdAt: now() } });
    const expired = new Date(Date.now() - 5000).toISOString();
    await prisma.approval.update({ where: { id: pendingRow.id }, data: { status: 'approved', decisionToken: 'dead-token', decisionExpiresAt: expired } });
    await prisma.approval.update({ where: { id: receiptRow.id }, data: { status: 'approved', decisionToken: 'dead-token', decisionExpiresAt: expired } });
    await recoverExpiredDecisions();
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: pendingRow.id } })).status).toBe('pending');
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: receiptRow.id } })).status).toBe('executed');
  });

  it('returns RUN_BUSY when another request in the conversation is still active', async () => {
    const agent = new AgentService({
      stream: withTestToolLoading(async function* (messages: ModelMessage[]) {
        if (messages.some((message) => message.role === 'tool')) { yield { text: '时间已经读到。' }; return; }
        yield { toolCalls: [{ id: 'call_busy', name: 'get_time', arguments: {} }] };
      }),
    } as never);
    const chat = await agent.chat({ message: '占用当前请求', pageContext: { page: 'inbox' }, requestKey: `busy-${Date.now()}` });
    const active = await prisma.agentRun.findFirstOrThrow({ where: { conversationId: chat.conversationId }, orderBy: { createdAt: 'desc' } });
    await prisma.agentRun.update({ where: { id: active.id }, data: { state: 'waiting_approval', pauseReason: null } });
    const extra = await prisma.message.create({ data: { conversationId: active.conversationId, role: 'user', content: '暂停的旧请求', status: 'completed', createdAt: now() } });
    const paused = await prisma.agentRun.create({ data: { conversationId: active.conversationId, sourceUserMessageId: extra.id, requestKey: `busy-paused-${Date.now()}`, requestHash: 'paused', state: 'paused', pauseReason: 'new_user_message', contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt: now(), updatedAt: now() } });
    await expect(resumeRun(paused.id, async function* () { yield { text: '不该继续。' }; }, new ContextService())).rejects.toMatchObject({ code: 'RUN_BUSY' });
  });
});
