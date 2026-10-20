import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { builtinSystemPrompt } from './agent/capabilities.js';
import type { StoredChatContext } from './agent/chat-context.js';

const at = () => new Date().toISOString();
const entry = (name: string, dirtyCount = 0) => ({ path: `/data/node/worktrees/o1/${name}`, name: `o1/${name}`, branch: `orch/x-${name}`, head: 'a'.repeat(40), dirtyCount, sizeBytes: 2048, sizeTruncated: false, modifiedAt: at(), broken: false });
let nodeId = ''; let conversationId = ''; let messageId = '';

async function call(name: string, args: Record<string, unknown>, toolCallId = 'call_1') {
  return executeBuiltinTool({ name, args, context: {} as StoredChatContext, toolCallId, run: { id: 'run-x', leaseToken: 'lease', conversationId, assistantMessageId: messageId, sourceUserMessageId: messageId } });
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
  });
});
