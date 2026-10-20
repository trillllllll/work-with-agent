import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { builtinSystemPrompt } from './agent/capabilities.js';
import type { StoredChatContext } from './agent/chat-context.js';
import type { Clock } from './agent/time.js';
import { weekRange } from './application/orchestration/week-range.js';

const at = () => new Date().toISOString();
const entry = (name: string, dirtyCount = 0) => ({ path: `/data/node/worktrees/o1/${name}`, name: `o1/${name}`, branch: `orch/x-${name}`, head: 'a'.repeat(40), dirtyCount, sizeBytes: 2048, sizeTruncated: false, modifiedAt: at(), broken: false });
let nodeId = ''; let conversationId = ''; let messageId = '';

async function call(name: string, args: Record<string, unknown>, toolCallId = 'call_1', extra?: { clock?: Clock; context?: StoredChatContext }) {
  return executeBuiltinTool({ name, args, context: extra?.context ?? {} as StoredChatContext, clock: extra?.clock, toolCallId, run: { id: 'run-x', leaseToken: 'lease', conversationId, assistantMessageId: messageId, sourceUserMessageId: messageId } });
}

beforeAll(async () => {
  const inventory = { worktrees: [entry('clean'), entry('dirty', 3)], runs: { count: 1, sizeBytes: 10 }, freeBytes: 5e10, scannedAt: at() };
  nodeId = (await prisma.agentNode.create({ data: { name: '助手测试执行端', tokenHash: `assistant-tools-${Date.now()}`, inventoryJson: JSON.stringify(inventory), inventoryAt: at(), lastSeenAt: at(), createdAt: at(), updatedAt: at() } })).id;
  conversationId = (await prisma.conversation.create({ data: { createdAt: at(), updatedAt: at() } })).id;
  messageId = (await prisma.message.create({ data: { conversationId, role: 'assistant', content: '', createdAt: at() } })).id;
});

afterAll(async () => {
  await prisma.nodeJob.deleteMany({ where: { nodeId } });
  await prisma.worktreeCleanup.deleteMany({ where: { nodeId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.agentNode.deleteMany({ where: { id: nodeId } });
});

describe('assistant orchestration tools', () => {
  it('reads nodes and the last reported worktrees without dispatching anything', async () => {
    const nodes = await call('orchestration_read', { action: 'nodes' });
    expect(nodes.success).toBe(true);
    expect((nodes.data as { items: Array<{ id: string; online: boolean }> }).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: nodeId, online: true })]));
    const listed = await call('orchestration_read', { action: 'worktrees', nodeId });
    const view = (listed.data as { items: Array<{ worktrees: Array<{ name: string; action: string }> }> }).items[0]!;
    expect(view.worktrees.map((item) => [item.name, item.action])).toEqual([['o1/clean', 'remove'], ['o1/dirty', 'blocked']]);
    expect(await prisma.nodeJob.count({ where: { nodeId } })).toBe(0);
    const bad = await call('orchestration_read', { action: 'get' });
    expect(bad).toMatchObject({ success: false, code: 'INVALID_TOOL_ARGUMENTS' });
  });

  it('only creates a pending assistant card and a chat part; the node gets nothing until the user confirms', async () => {
    const result = await call('propose_worktree_cleanup', { nodeId, paths: [entry('clean').path, entry('dirty').path], reason: '轮次已验收' });
    expect(result.success).toBe(true);
    const data = result.data as { status: string; cleanupId: string; removableCount: number };
    expect(data).toMatchObject({ status: 'pending_user_confirmation', removableCount: 1 });
    const card = await prisma.worktreeCleanup.findUniqueOrThrow({ where: { id: data.cleanupId } });
    expect(card).toMatchObject({ status: 'pending', source: 'assistant', jobId: null });
    expect(await prisma.nodeJob.count({ where: { nodeId } })).toBe(0);
    expect(result.part).toMatchObject({ type: 'worktree_cleanup', cleanupId: data.cleanupId, removableCount: 1, blockedCount: 1 });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(JSON.parse(message.partsJson ?? '[]')).toEqual([result.part]);
    // Replaying the same tool call does not duplicate the chat part.
    await call('propose_worktree_cleanup', { nodeId, paths: [entry('clean').path] });
    expect(JSON.parse((await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).partsJson ?? '[]')).toHaveLength(1);
  });

  it('rejects unknown nodes and tells the model it cannot delete directly', async () => {
    expect(await call('propose_worktree_cleanup', { nodeId: 'missing', paths: ['/x'] }, 'call_2')).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(builtinSystemPrompt()).toContain('删除 worktree 只能用 propose_worktree_cleanup 生成确认卡片');
    expect(builtinSystemPrompt()).toContain('用户问 AI 干了多少活、花了多少 token/钱、通过率时用 orchestration_stats；不能凭记忆编数字。');
  });

  it('reads dispatch stats for this week without creating a node job', async () => {
    const clock: Clock = { now: () => new Date('2026-10-21T07:00:00.000Z') };
    const before = await prisma.nodeJob.count({ where: { nodeId } });
    const result = await call('orchestration_stats', {}, 'call_stats', { clock });
    expect(result.success).toBe(true);
    const data = result.data as { from: string; to: string; timeZone: string; note: string; projectId: string | null };
    const range = weekRange(clock.now(), 'Asia/Shanghai');
    expect(data.timeZone).toBe('Asia/Shanghai');
    expect(data.from).toBe(range.from);
    expect(data.to).toBe(range.to);
    expect(data.projectId).toBeNull();
    expect(data.note).toContain('没有费用数据的步骤要说明费用未知');
    expect(await prisma.nodeJob.count({ where: { nodeId } })).toBe(before);

    const context = { timeZone: 'America/New_York', timeZoneSource: 'context' } as StoredChatContext;
    const zoned = await call('orchestration_stats', {}, 'call_stats_zone', { clock, context });
    const zonedData = zoned.data as { from: string; to: string; timeZone: string };
    expect(zonedData.timeZone).toBe('America/New_York');
    expect(zonedData.from).toBe(weekRange(clock.now(), 'America/New_York').from);
    expect(zonedData.to).toBe(weekRange(clock.now(), 'America/New_York').to);

    const ignored = await call('orchestration_stats', {}, 'call_stats_default', { clock, context: { timeZone: 'America/New_York', timeZoneSource: 'default' } as StoredChatContext });
    expect((ignored.data as { timeZone: string }).timeZone).toBe('Asia/Shanghai');
    const explicit = await call('orchestration_stats', { timeZone: 'Europe/Berlin', from: '2099-03-01T00:00:00.000Z', to: '2099-03-02T00:00:00.000Z' }, 'call_stats_explicit', { clock, context });
    expect(explicit.data).toMatchObject({ timeZone: 'Europe/Berlin', from: '2099-03-01T00:00:00.000Z', to: '2099-03-02T00:00:00.000Z' });

    const empty = await call('orchestration_stats', { projectId: 'missing-project-2099', from: '2099-01-01T00:00:00.000Z', to: '2099-01-08T00:00:00.000Z' }, 'call_stats_empty', { clock });
    expect(empty.data).toMatchObject({
      projectId: 'missing-project-2099',
      roundCount: 0,
      stepCount: 0,
      firstPass: { passed: 0, total: 0, rate: null },
      rework: 0,
      rejected: 0,
      resources: { jobs: 0, inputTokens: 0, costMicroUsd: 0, noCostJobs: 0 },
      legacy: { count: 0, inputTokens: 0 },
      top5ByDuration: [],
      top5ByCost: [],
    });
    expect(await call('orchestration_stats', { from: '2099-01-01T00:00:00.000Z' }, 'call_stats_half', { clock })).toMatchObject({ success: false, code: 'INVALID_STATS_RANGE', error: '统计需要同时提供开始和结束时间' });
    expect(await call('orchestration_stats', { timeZone: 'Not/AZone' }, 'call_stats_bad_zone', { clock })).toMatchObject({ success: false, code: 'INVALID_TIME_ZONE', error: '时区无效' });
    expect(await prisma.nodeJob.count({ where: { nodeId } })).toBe(before);
  });
});
