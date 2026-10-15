import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import type { ModelMessage } from './agent.js';
import { ContextService } from './application/conversation.js';
import { applyExecutorSideEffect, checkAgentRuns, resetRunSchedulerState, setRunClock } from './agent/runs.js';

const cursor = JSON.stringify({ schemaVersion: 1, phase: 'model', round: 0, budgetEndRound: 16, assistantMessageId: null, nextToolIndex: 0 });
const context = JSON.stringify({ schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'default', referencedApprovalId: null });

afterEach(async () => {
  setRunClock(null);
  resetRunSchedulerState();
  const runs = await prisma.agentRun.findMany({ where: { id: { startsWith: 'repair-run-' } }, select: { id: true, conversationId: true } });
  const runIds = runs.map((run) => run.id);
  const conversationIds = runs.map((run) => run.conversationId);
  if (runIds.length) await prisma.agentRunEvent.deleteMany({ where: { runId: { in: runIds } } });
  if (conversationIds.length) await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  if (runIds.length) await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
  if (conversationIds.length) await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
});

async function queuedRun(id: string, createdAt: string) {
  const conversation = await prisma.conversation.create({ data: { id: `repair-conv-${id}`, createdAt, updatedAt: createdAt } });
  const message = await prisma.message.create({ data: { id: `repair-msg-${id}`, conversationId: conversation.id, role: 'user', content: id, status: 'completed', createdAt } });
  const run = await prisma.agentRun.create({ data: { id: `repair-run-${id}`, conversationId: conversation.id, sourceUserMessageId: message.id, requestKey: `repair-key-${id}`, requestHash: id, state: 'queued', contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt, updatedAt: createdAt } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeRunId: run.id } });
  return run;
}

describe('continuous run recovery', () => {
  it('pauses an unexpired orphan on the first check after its lease expires', async () => {
    const start = new Date('2026-10-15T00:00:00.000Z');
    setRunClock(() => start);
    const createdAt = start.toISOString();
    const conversation = await prisma.conversation.create({ data: { id: 'repair-conv-orphan', createdAt, updatedAt: createdAt } });
    const message = await prisma.message.create({ data: { id: 'repair-msg-orphan', conversationId: conversation.id, role: 'user', content: '孤立请求', status: 'completed', createdAt } });
    const run = await prisma.agentRun.create({ data: { id: 'repair-run-orphan', conversationId: conversation.id, sourceUserMessageId: message.id, requestKey: 'repair-key-orphan', requestHash: 'orphan', state: 'running', leaseToken: 'live-token', leaseExpiresAt: new Date(start.getTime() + 60_000).toISOString(), contextJson: context, modelMessagesJson: '[]', cursorJson: cursor, createdAt, updatedAt: createdAt } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { activeRunId: run.id } });
    const seen: string[] = [];
    await checkAgentRuns(async function* (messages: ModelMessage[]) { seen.push(JSON.stringify(messages)); yield { text: '不该重做。' }; }, new ContextService());
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe('running');
    setRunClock(() => new Date(start.getTime() + 61_000));
    await checkAgentRuns();
    const paused = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(paused.state).toBe('paused');
    expect(paused.pauseReason).toBe('interrupted');
    expect(seen).toEqual([]);
    await expect(applyExecutorSideEffect(run.id, 'live-token', message.id, { content: '迟到结果' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content).toBe('孤立请求');
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe('paused');
  });

  it('drains five queued requests with at most two running and does not repeat a held schedule', async () => {
    await prisma.agentRun.updateMany({ where: { state: { in: ['queued', 'running'] } }, data: { state: 'cancelled', leaseToken: null, leaseExpiresAt: null } });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const [index, id] of ids.entries()) await queuedRun(id, new Date(Date.UTC(2026, 9, 15, 1, 0, index)).toISOString());
    let calls = 0;
    let active = 0;
    let max = 0;
    const waiting: Array<() => void> = [];
    const stream = async function* () {
      calls += 1;
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => waiting.push(resolve));
      active -= 1;
      yield { text: `完成 ${calls}` };
    };
    const until = async (ready: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`scheduler timeout calls=${calls} active=${active}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };
    try {
      await checkAgentRuns(stream, new ContextService());
      await until(() => active === 2);
      expect(max).toBe(2);
      expect(calls).toBe(2);
      await checkAgentRuns();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(2);
      while ((await prisma.agentRun.count({ where: { id: { in: ids.map((id) => `repair-run-${id}`) }, state: 'completed' } })) < 5) {
        const release = waiting.shift();
        if (release) release();
        else await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(max).toBeLessThanOrEqual(2);
      expect(calls).toBe(5);
    } finally {
      waiting.splice(0).forEach((release) => release());
    }
  });
});
